import { describe, expect, it } from "vitest";
import { decideOverlayAction, nextOverlayAfterSwitch, shouldPreload } from "../src/shared/overlay.js";
import type { OverlayState } from "../src/shared/types.js";

const clip = (id: string, index: number) => ({
  jobId: id,
  sceneIndex: index,
  playbackUrl: `/media/scenes/${id}/playback.mp4`,
});

describe("overlay playback", () => {
  it("holds before the first scene and during emergency hold", () => {
    expect(decideOverlayAction({ hold: false, hasCurrent: false, hasNext: false, event: "init" })).toBe("hold");
    expect(decideOverlayAction({ hold: true, hasCurrent: true, hasNext: true, event: "ended" })).toBe("hold");
  });

  it("loops the latest scene when the next clip is not ready", () => {
    expect(decideOverlayAction({ hold: false, hasCurrent: true, hasNext: false, event: "ended" })).toBe("loop");
  });

  it("switches at clip end when the next scene is preloaded", () => {
    expect(decideOverlayAction({ hold: false, hasCurrent: true, hasNext: true, event: "ended" })).toBe("switch");
    const state: OverlayState = {
      hold: false,
      muted: false,
      sessionStatus: "running",
      current: clip("a", 1),
      next: clip("b", 2),
      waitingForFirstScene: false,
    };
    expect(shouldPreload(state)).toBe(true);
    expect(nextOverlayAfterSwitch(state).current?.jobId).toBe("b");
    expect(nextOverlayAfterSwitch(state).next).toBeNull();
  });
});
