import { describe, expect, it } from "vitest";
import { extractJobId, extractResultUrl, extractStatus, parseHiggsfieldPayload } from "../src/server/providers/higgsfield.js";

describe("Higgsfield payload parsing", () => {
  it("extracts job ids and result urls from nested JSON", () => {
    const payload = parseHiggsfieldPayload(`note
{"data":{"jobs":[{"id":"job_123","status":"completed","results":[{"url":"https://cdn.example/video.mp4"}]}]}}`);
    expect(extractJobId(payload)).toBe("job_123");
    expect(extractStatus(payload)).toBe("completed");
    expect(extractResultUrl(payload)).toBe("https://cdn.example/video.mp4");
  });

  it("accepts an array of job objects", () => {
    const payload = [{ jobId: "abc", state: "running" }];
    expect(extractJobId(payload)).toBe("abc");
    expect(extractStatus(payload)).toBe("running");
  });
});
