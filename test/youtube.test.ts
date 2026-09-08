import { describe, expect, it } from "vitest";
import { classifyYouTubeError } from "../src/server/youtube.js";

describe("YouTube error classification", () => {
  it("detects ended and disabled live chat", () => {
    expect(classifyYouTubeError(new Error("liveChatEnded"))).toMatchObject({ status: "ended" });
    expect(classifyYouTubeError({ errors: [{ reason: "liveChatDisabled" }] })).toMatchObject({
      status: "disabled",
    });
    expect(classifyYouTubeError(new Error("rate limit"))).toMatchObject({ status: "error" });
  });
});
