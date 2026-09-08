import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/http.js";
import { YouTubeChatService } from "../src/server/youtube.js";
import { AGENT_INACTIVE_MS } from "../src/shared/types.js";
import { ControllableClock, MockProvider, tempEngine } from "./helpers.js";

const apps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (apps.length) {
    await apps.pop()?.close();
  }
});

describe("HTTP controls", () => {
  it("streams agent liveness to the dashboard without creating director updates", async () => {
    const clock = new ControllableClock(new Date("2026-01-01T00:00:00.000Z"));
    const ctx = tempEngine(clock);
    const config = { ...loadConfig(ctx.dir), controlToken: "test-token" };
    const app = await createApp({
      config, engine: ctx.engine,
      youtube: new YouTubeChatService(ctx.engine, ctx.dir, config.publicUrl),
      providerFor: () => new MockProvider(), demoScript: [], rootDir: process.cwd(),
    });
    apps.push({ close: async () => { await app.close(); ctx.close(); } });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();
    const response = await fetch(`${url}/api/events`, {
      headers: { "x-chat-director-token": "test-token" }, signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextSnapshot = async () => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Dashboard stream ended unexpectedly");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(frame.slice("data: ".length));
    };
    try {
      expect(response.status).toBe(200);
      const initial = await nextSnapshot();
      expect(initial.agent.connected).toBe(false);
      ctx.engine.recordAgentHeartbeat();
      const connected = await nextSnapshot();
      expect(connected.agent.connected).toBe(true);
      expect(connected.seq).toBe(initial.seq);
      clock.advance(AGENT_INACTIVE_MS + 1);
      const inactive = await nextSnapshot();
      expect(inactive.agent.connected).toBe(false);
      expect(inactive.seq).toBe(initial.seq);
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("waits while idle without waking on heartbeats, then wakes for new chat", async () => {
    const ctx = tempEngine();
    const config = { ...loadConfig(ctx.dir), controlToken: "test-token" };
    const app = await createApp({
      config,
      engine: ctx.engine,
      youtube: new YouTubeChatService(ctx.engine, ctx.dir, config.publicUrl),
      providerFor: () => new MockProvider(),
      demoScript: [],
      rootDir: process.cwd(),
    });
    apps.push({ close: async () => { await app.close(); ctx.close(); } });
    const headers = { "x-chat-director-token": "test-token" };
    const initial = (await app.inject({ method: "GET", url: "/api/agent/session", headers })).json();
    const before = performance.now();
    const idle = await app.inject({
      method: "GET", url: `/api/agent/wait?sinceSeq=${initial.seq}&timeoutMs=80`, headers,
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.json().seq).toBe(initial.seq);
    expect(performance.now() - before).toBeGreaterThanOrEqual(60);
    expect(idle.json().agent.connected).toBe(true);

    const waiting = app.inject({
      method: "GET", url: `/api/agent/wait?sinceSeq=${initial.seq}&timeoutMs=1000`, headers,
    }).then((response) => response.json());
    let resolved = false;
    void waiting.then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    ctx.engine.recordAgentHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    ctx.engine.ingestChat([{
      id: "wake-chat", author: "viewer", text: "Find the library", publishedAt: ctx.engine.nowIso(),
    }]);
    const updated = await waiting;
    expect(updated.seq).toBeGreaterThan(initial.seq);
    expect(updated.unreadChat.map((message: { id: string }) => message.id)).toContain("wake-chat");
  });

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
