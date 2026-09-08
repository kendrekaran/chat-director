import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/http.js";
import { YouTubeChatService } from "../src/server/youtube.js";
import { MockProvider, tempEngine } from "./helpers.js";

const apps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

describe("HTTP controls", () => {
  it("protects control endpoints and accepts agent submissions", async () => {
    const ctx = tempEngine();
    const config = {
      ...loadConfig(ctx.dir),
      dataDir: ctx.dir,
      controlToken: "test-token",
      fixturesDir: `${process.cwd()}/fixtures/demo`,
    };
    const app = await createApp({
      config,
      engine: ctx.engine,
      youtube: new YouTubeChatService(ctx.engine, ctx.dir, "http://127.0.0.1:8787"),
      providerFor: () => new MockProvider(),
      demoScript: [],
      rootDir: process.cwd(),
    });
    apps.push({
      close: async () => {
        await app.close();
        ctx.close();
      },
    });

    const denied = await app.inject({ method: "GET", url: "/api/session" });
    expect(denied.statusCode).toBe(401);

    ctx.engine.updateSetup({ premise: "A lantern fox searches a flooded city.", demoAutoDirector: false });
    const started = await app.inject({
      method: "POST",
      url: "/api/session/start",
      headers: { "x-chat-director-token": "test-token" },
      payload: { mode: "demo" },
    });
    expect(started.statusCode).toBe(200);

    const submit = await app.inject({
      method: "POST",
      url: "/api/agent/submit",
      headers: { "x-chat-director-token": "test-token" },
      payload: {
        prompt: "Opening lantern grove",
        supportingMessageIds: [],
        proposedProgression: { summary: "The story begins." },
      },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().duplicate).toBe(false);

    const replay = await app.inject({
      method: "POST",
      url: "/api/agent/submit",
      headers: { "x-chat-director-token": "test-token" },
      payload: {
        prompt: "Opening lantern grove",
        supportingMessageIds: [],
        proposedProgression: { summary: "The story begins." },
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);

    const overlay = await app.inject({ method: "GET", url: "/api/overlay/state" });
    expect(overlay.statusCode).toBe(200);
    expect(overlay.json().waitingForFirstScene).toBe(true);
  });
});
