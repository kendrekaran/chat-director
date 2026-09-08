import { describe, expect, it } from "vitest";
import { processOnce } from "../src/server/worker.js";
import { MockProvider, openingProposal, tempEngine } from "./helpers.js";

describe("generation worker", () => {
  it("persists submission intent and records provider rejection without a second submit", async () => {
    const ctx = tempEngine();
    ctx.engine.updateSetup({ premise: "A lantern fox searches a flooded city." });
    ctx.engine.start("demo");
    const submitted = ctx.engine.submitScene(openingProposal());
    if (!submitted.ok) throw new Error("expected job");
    const provider = new MockProvider();
    provider.nextSubmit = { ok: false, kind: "rejected", error: "safety filter" };
    await processOnce({
      engine: ctx.engine,
      providerFor: () => provider,
      dataDir: ctx.dir,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    expect(provider.submits).toHaveLength(1);
    expect(ctx.engine.requireJob(submitted.job.id).status).toBe("rejected");
    await processOnce({
      engine: ctx.engine,
      providerFor: () => provider,
      dataDir: ctx.dir,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    expect(provider.submits).toHaveLength(1);
    ctx.close();
  });

  it("does not automatically resubmit an ambiguous paid request", async () => {
    const ctx = tempEngine();
    ctx.engine.updateSetup({ premise: "A lantern fox searches a flooded city." });
    ctx.engine.start("demo");
    const submitted = ctx.engine.submitScene(openingProposal());
    if (!submitted.ok) throw new Error("expected job");
    const provider = new MockProvider();
    provider.nextSubmit = { ok: false, kind: "ambiguous", error: "timeout after send" };
    await processOnce({
      engine: ctx.engine,
      providerFor: () => provider,
      dataDir: ctx.dir,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    expect(ctx.engine.requireJob(submitted.job.id).status).toBe("ambiguous");
    expect(ctx.engine.requireJob(submitted.job.id).ambiguous).toBe(true);
    await processOnce({
      engine: ctx.engine,
      providerFor: () => provider,
      dataDir: ctx.dir,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    expect(provider.submits).toHaveLength(1);
    ctx.close();
  });

  it("recovers a known provider job by polling the stored id", async () => {
    const ctx = tempEngine();
    ctx.engine.updateSetup({ premise: "A lantern fox searches a flooded city." });
    ctx.engine.start("demo");
    const submitted = ctx.engine.submitScene(openingProposal());
    if (!submitted.ok) throw new Error("expected job");
    ctx.engine.markSubmitted(submitted.job.id, "hf-known");
    const report = ctx.engine.recoverOnBoot();
    expect(report.resumable).toEqual([submitted.job.id]);
    const provider = new MockProvider();
    provider.nextPoll = { status: "running" };
    await processOnce({
      engine: ctx.engine,
      providerFor: () => provider,
      dataDir: ctx.dir,
      ffmpegBin: "ffmpeg",
      ffprobeBin: "ffprobe",
    });
    expect(provider.pollCounts.get("hf-known")).toBe(1);
    expect(ctx.engine.requireJob(submitted.job.id).status).toBe("generating");
    expect(provider.submits).toHaveLength(0);
    ctx.close();
  });
});
