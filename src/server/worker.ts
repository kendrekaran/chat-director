import { join } from "node:path";
import type { ChatDirectorEngine } from "./engine.js";
import { prepareSceneMedia } from "./ffmpeg.js";
import { materializeSource } from "./download.js";
import type { GenerationProvider } from "./providers/types.js";

export interface WorkerOptions {
  engine: ChatDirectorEngine;
  providerFor: (mode: "demo" | "live") => GenerationProvider;
  dataDir: string;
  ffmpegBin: string;
  ffprobeBin: string;
  intervalMs?: number;
}

export function startWorker(options: WorkerOptions): { stop: () => void } {
  let stopped = false;
  let busy = false;
  const intervalMs = options.intervalMs ?? 750;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await processOnce(options);
    } catch (error) {
      options.engine.recordError(
        "worker",
        error instanceof Error ? error.message : "Worker tick failed.",
      );
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export async function processOnce(options: WorkerOptions): Promise<boolean> {
  const session = options.engine.requireSession();
  if (session.status !== "running") return false;
  const job = options.engine.claimNextWork();
  if (!job) return false;
  const provider = options.providerFor(session.mode);
  const outputDir = join(options.dataDir, "media", "scenes", job.id);

  if (job.status === "pending") {
    const submitted = await provider.submit({
      prompt: job.prompt,
      durationSec: session.limits.sceneDurationSec,
      startImagePath: job.startImagePath,
      jobId: job.id,
    });
    if (submitted.ok) {
      options.engine.markSubmitted(job.id, submitted.providerJobId);
      return true;
    }
    if (submitted.kind === "rejected") {
      options.engine.markRejected(job.id, submitted.error);
      return true;
    }
    options.engine.markAmbiguous(job.id, submitted.error);
    return true;
  }

  if ((job.status === "submitted" || job.status === "generating") && job.providerJobId) {
    if (job.status === "submitted") options.engine.markGenerating(job.id);
    const polled = await provider.poll(job.providerJobId);
    if (polled.status === "running") return true;
    if (polled.status === "succeeded") {
      options.engine.markDownloading(job.id, polled.result);
      return true;
    }
    if (polled.kind === "rejected") {
      options.engine.markRejected(job.id, polled.error);
      return true;
    }
    if (polled.kind === "ambiguous") {
      options.engine.markAmbiguous(job.id, polled.error);
      return true;
    }
    options.engine.markFailed(job.id, polled.error);
    return true;
  }

  if (job.status === "downloading") {
    if (!job.providerResultUrl) {
      options.engine.markAmbiguous(job.id, "Download interrupted with no known result URL.");
      return true;
    }
    const sourcePath = join(outputDir, "source.mp4");
    const materialized = await materializeSource(job.providerResultUrl, sourcePath);
    options.engine.markPreparing(job.id, materialized);
    return true;
  }

  if (job.status === "preparing") {
    if (!job.sourcePath) {
      options.engine.markFailed(job.id, "Prepare interrupted with no source file.");
      return true;
    }
    const prepared = await prepareSceneMedia({
      inputPath: job.sourcePath,
      outputDir,
      ffmpegBin: options.ffmpegBin,
      ffprobeBin: options.ffprobeBin,
    });
    options.engine.completePrepared(job.id, {
      sourcePath: prepared.sourcePath,
      playbackPath: prepared.playbackPath,
      lastFramePath: prepared.lastFramePath,
    });
    return true;
  }

  return false;
}
