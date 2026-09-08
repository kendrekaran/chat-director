import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareSceneMedia, probeMedia } from "../src/server/ffmpeg.js";
import { runArgv } from "../src/server/providers/higgsfield.js";

describe("FFmpeg scene prepare", () => {
  it("validates video, keeps audio, and extracts a last frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cd-ff-"));
    const source = join(dir, "source.mp4");
    const generated = await runArgv(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=0x1A120C:s=640x360:d=1",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        source,
      ],
      30_000,
    );
    expect(generated.code).toBe(0);
    const prepared = await prepareSceneMedia({
      inputPath: source,
      outputDir: join(dir, "out"),
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    const probe = await probeMedia("ffprobe", prepared.playbackPath);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(prepared.lastFramePath.endsWith("last-frame.jpg")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
