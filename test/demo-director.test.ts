import { describe, expect, it } from "vitest";
import { maybeDirect } from "../src/server/demo-feed.js";
import { tempEngine } from "./helpers.js";

describe("demo director", () => {
  it("opens from the premise, then waits until unused chat arrives", () => {
    const ctx = tempEngine();
    ctx.engine.updateSetup({
      premise: "A lantern fox searches a flooded city.",
      demoAutoDirector: true,
    });
    ctx.engine.start("demo");
    expect(maybeDirect(ctx.engine)).toBe(true);
    expect(maybeDirect(ctx.engine)).toBe(false);
    const job = ctx.engine.getSnapshot().jobs[0]!;
    ctx.engine.completePrepared(job.id, {
      sourcePath: "/tmp/a.mp4",
      playbackPath: "/tmp/a-play.mp4",
      lastFramePath: "/tmp/a.jpg",
    });
    expect(maybeDirect(ctx.engine)).toBe(false);
    ctx.engine.ingestChat([
      { id: "demo-1", author: "mira", text: "Find a dry door", publishedAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(maybeDirect(ctx.engine)).toBe(true);
    ctx.close();
  });
});
