import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runArgv } from "./providers/higgsfield.js";

export interface PreparedMedia {
  sourcePath: string;
  playbackPath: string;
  lastFramePath: string;
  durationSec: number;
  hasAudio: boolean;
}

export async function prepareSceneMedia(options: {
  inputPath: string;
  outputDir: string;
  ffmpegBin: string;
  ffprobeBin: string;
}): Promise<PreparedMedia> {
  mkdirSync(options.outputDir, { recursive: true });
  const probe = await probeMedia(options.ffprobeBin, options.inputPath);
  if (!probe.hasVideo) {
    throw new Error("Downloaded file has no video stream.");
  }
  const playbackPath = join(options.outputDir, "playback.mp4");
  const lastFramePath = join(options.outputDir, "last-frame.jpg");
  await transcodeForBrowser(options.ffmpegBin, options.inputPath, playbackPath);
  await extractLastFrame(options.ffmpegBin, playbackPath, lastFramePath);
  const prepared = await probeMedia(options.ffprobeBin, playbackPath);
  if (!prepared.hasVideo) {
    throw new Error("Prepared playback file has no video stream.");
  }
  return {
    sourcePath: options.inputPath,
    playbackPath,
    lastFramePath,
    durationSec: prepared.durationSec,
    hasAudio: prepared.hasAudio,
  };
}

export async function probeMedia(
  ffprobeBin: string,
  filePath: string,
): Promise<{ hasVideo: boolean; hasAudio: boolean; durationSec: number }> {
  const { stdout, code, stderr } = await runArgv(
    ffprobeBin,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    20_000,
  );
  if (code !== 0) {
    throw new Error(stderr.trim() || "ffprobe failed.");
  }
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string }>;
  };
  const streams = parsed.streams ?? [];
  return {
    hasVideo: streams.some((stream) => stream.codec_type === "video"),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    durationSec: Number(parsed.format?.duration ?? 0),
  };
}

async function transcodeForBrowser(ffmpegBin: string, inputPath: string, outputPath: string): Promise<void> {
  mkdirSync(dirname(outputPath), { recursive: true });
  const { code, stderr } = await runArgv(
    ffmpegBin,
    [
      "-y",
      "-i",
      inputPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-shortest",
      outputPath,
    ],
    120_000,
  );
  if (code !== 0) {
    throw new Error(stderr.trim() || "ffmpeg playback transcode failed.");
  }
}

async function extractLastFrame(ffmpegBin: string, inputPath: string, outputPath: string): Promise<void> {
  const { code, stderr } = await runArgv(
    ffmpegBin,
    ["-y", "-sseof", "-0.15", "-i", inputPath, "-frames:v", "1", "-update", "1", "-q:v", "2", outputPath],
    30_000,
  );
  if (code !== 0) {
    throw new Error(stderr.trim() || "ffmpeg last-frame extract failed.");
  }
}
