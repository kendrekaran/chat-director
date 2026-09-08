import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ChatDirectorEngine } from "./engine.js";
import { startDemoChat, startDemoDirector, type DemoChatLine } from "./demo-feed.js";
import { startWorker } from "./worker.js";
import type { GenerationProvider } from "./providers/types.js";
import type { YouTubeChatService } from "./youtube.js";
import type { SessionMode } from "../shared/types.js";

const setupSchema = z.object({
  premise: z.string().optional(),
  visualStyle: z.string().optional(),
  characters: z
    .array(z.object({ name: z.string().min(1), description: z.string() }))
    .optional(),
  boundaries: z
    .object({
      blockedTerms: z.array(z.string()).optional(),
      rules: z.string().optional(),
    })
    .optional(),
  limits: z
    .object({
      sceneDurationSec: z.number().optional(),
      maxSubmissions: z.number().optional(),
    })
    .optional(),
  demoAutoDirector: z.boolean().optional(),
});

const proposalSchema = z.object({
  prompt: z.string(),
  supportingMessageIds: z.array(z.string()).default([]),
  proposedProgression: z.object({
    summary: z.string(),
    events: z.array(z.string()).optional(),
    characterUpdates: z
      .array(z.object({ name: z.string(), description: z.string() }))
      .optional(),
  }),
});

export interface AppDependencies {
  config: AppConfig;
  engine: ChatDirectorEngine;
  youtube: YouTubeChatService;
  providerFor: (mode: "demo" | "live") => GenerationProvider;
  demoScript: DemoChatLine[];
  rootDir: string;
}

export async function createApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.VITEST !== "true" });
  const { engine, config, youtube } = deps;
  let worker: { stop: () => void } | null = null;
  let demoChat: { stop: () => void } | null = null;
  let demoDirector: { stop: () => void } | null = null;

  const stopAux = () => {
    demoChat?.stop();
    demoChat = null;
    demoDirector?.stop();
    demoDirector = null;
    youtube.stopPolling();
  };

  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
  });

  app.addHook("onRequest", async (request, reply) => {
    if (isPublicPath(request.url)) return;
    const token = headerToken(request) ?? queryToken(request);
    if (token !== config.controlToken) {
      return reply.code(401).send({
        error: "unauthorized",
        hint: "Send X-Chat-Director-Token. The token is stored in data/control-token.",
      });
    }
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/session", async () => engine.getSnapshot());

  app.patch("/api/session/setup", async (request, reply) => {
    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      engine.updateSetup(parsed.data);
      return engine.getSnapshot();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Setup failed." });
    }
  });

  app.post("/api/session/start", async (request, reply) => {
    const body = z.object({ mode: z.enum(["demo", "live"]).default("demo") }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      engine.start(body.data.mode);
      startRuntime(body.data.mode);
      return engine.getSnapshot();
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "Start failed." });
    }
  });

  app.post("/api/session/pause", async () => {
    engine.pause();
    return engine.getSnapshot();
  });

  app.post("/api/session/resume", async () => {
    engine.resume();
    return engine.getSnapshot();
  });

  app.post("/api/session/stop", async () => {
    engine.stop();
    stopAux();
    return engine.getSnapshot();
  });

  app.post("/api/session/hold", async (request) => {
    const body = z.object({ hold: z.boolean() }).parse(request.body ?? { hold: true });
    engine.setHold(body.hold);
    return engine.getSnapshot();
  });

  app.post("/api/session/mute", async (request) => {
    const body = z.object({ muted: z.boolean() }).parse(request.body ?? { muted: true });
    engine.setMuted(body.muted);
    return engine.getSnapshot();
  });

  app.post("/api/demo/inject", async (request, reply) => {
    const body = z
      .object({
        id: z.string().optional(),
        author: z.string().default("viewer"),
        text: z.string().min(1),
      })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    engine.ingestChat([
      {
        id: body.data.id ?? `inject-${Date.now()}`,
        author: body.data.author,
        text: body.data.text,
        publishedAt: engine.nowIso(),
      },
    ]);
    return engine.getSnapshot();
  });

  app.get("/api/youtube/status", async () => ({
    ...youtube.status(),
    connection: engine.requireSession().youtube,
  }));

  app.post("/api/youtube/client", async (request, reply) => {
    const body = z
      .object({ clientId: z.string().min(3), clientSecret: z.string().min(3) })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    youtube.saveClient(body.data.clientId, body.data.clientSecret);
    return { ok: true, redirectUri: youtube.defaultRedirect(), authorizationUrl: youtube.authorizationUrl() };
  });

  app.get("/api/youtube/oauth/start", async (_request, reply) => {
    try {
      return { authorizationUrl: youtube.authorizationUrl() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "OAuth is not configured." });
    }
  });

  app.get("/api/youtube/oauth/callback", async (request, reply) => {
    const query = request.query as { code?: string; error?: string };
    if (query.error) {
      return reply.type("text/html").send(oauthResultPage("YouTube authorization failed.", query.error));
    }
    if (!query.code) {
      return reply.code(400).send({ error: "Missing code." });
    }
    try {
      await youtube.handleCallback(query.code);
      return reply.type("text/html").send(oauthResultPage("YouTube access granted.", "Return to the Chat Director dashboard and paste the live video ID."));
    } catch (error) {
      return reply
        .code(400)
        .type("text/html")
        .send(oauthResultPage("Could not store tokens.", error instanceof Error ? error.message : "unknown"));
    }
  });

  app.post("/api/youtube/connect", async (request, reply) => {
    const body = z.object({ videoId: z.string().min(3) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    try {
      await youtube.connectVideo(normalizeVideoId(body.data.videoId));
      return engine.getSnapshot();
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Connect failed." });
    }
  });

  app.get("/api/agent/session", async () => {
    engine.recordAgentHeartbeat();
    return engine.getSnapshot();
  });

  app.get("/api/agent/wait", async (request) => {
    engine.recordAgentHeartbeat();
    const query = request.query as { sinceSeq?: string; timeoutMs?: string };
    const since = Number(query.sinceSeq ?? engine.currentSeq());
    const timeoutMs = Math.min(Number(query.timeoutMs ?? 25_000), 60_000);
    return engine.waitForUpdates(Number.isFinite(since) ? since : 0, Number.isFinite(timeoutMs) ? timeoutMs : 25_000);
  });

  app.post("/api/agent/submit", async (request, reply) => {
    engine.recordAgentHeartbeat();
    const parsed = proposalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = engine.submitScene(parsed.data);
    if (!result.ok) {
      return reply.code(409).send(result);
    }
    return result;
  });

  app.post("/api/agent/heartbeat", async () => {
    engine.recordAgentHeartbeat();
    return engine.agentStatus();
  });

  app.get("/api/overlay/state", async () => engine.readyPlaylist());

  app.get("/api/overlay/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = () => {
      const state = engine.readyPlaylist();
      reply.raw.write(`data: ${JSON.stringify(state)}\n\n`);
    };
    send();
    const timer = setInterval(send, 1000);
    request.raw.on("close", () => {
      clearInterval(timer);
    });
  });

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const initial = engine.getSnapshot();
    let last = initial.seq;
    let lastAgent = JSON.stringify(initial.agent);
    const send = () => {
      const snapshot = engine.getSnapshot();
      const agent = JSON.stringify(snapshot.agent);
      // Heartbeats and inactivity still reach the desk without waking director waits.
      if (snapshot.seq !== last || agent !== lastAgent) {
        last = snapshot.seq;
        lastAgent = agent;
        reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }
    };
    reply.raw.write(`data: ${JSON.stringify(initial)}\n\n`);
    const timer = setInterval(send, 700);
    request.raw.on("close", () => clearInterval(timer));
  });

  const overlayDir = join(deps.rootDir, "public/overlay");
  await app.register(fastifyStatic, {
    root: overlayDir,
    prefix: "/overlay/",
    decorateReply: false,
  });

  app.get("/overlay", async (_request, reply) => {
    const html = readFileSync(join(overlayDir, "index.html"), "utf8");
    return reply.type("text/html").send(html);
  });

  const mediaRoot = join(config.dataDir, "media");
  mkdirSync(mediaRoot, { recursive: true });
  await app.register(fastifyStatic, {
    root: mediaRoot,
    prefix: "/media/",
    decorateReply: false,
  });

  const webDir = join(deps.rootDir, "dist/web");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, {
      root: webDir,
      prefix: "/",
      wildcard: false,
      decorateReply: true,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      return reply.sendFile("index.html");
    } catch {
      return reply.code(404).send({ error: "Dashboard is not built yet. Run npm run build or npm run dev." });
    }
  });

  const startRuntime = (mode: SessionMode) => {
    worker ??= startWorker({
      engine,
      providerFor: deps.providerFor,
      dataDir: config.dataDir,
      ffmpegBin: config.ffmpegBin,
      ffprobeBin: config.ffprobeBin,
    });
    stopAux();
    if (mode === "demo") {
      demoChat = startDemoChat(engine, deps.demoScript);
      demoDirector = startDemoDirector(engine);
    } else {
      youtube.startPolling();
    }
  };

  app.addHook("onClose", async () => {
    stopAux();
    worker?.stop();
  });

  const session = engine.requireSession();
  if (session.status === "running" || session.status === "paused") {
    worker = startWorker({
      engine,
      providerFor: deps.providerFor,
      dataDir: config.dataDir,
      ffmpegBin: config.ffmpegBin,
      ffprobeBin: config.ffprobeBin,
    });
    if (session.status === "running" && session.mode === "demo") {
      demoDirector = startDemoDirector(engine);
    } else if (session.status === "running") {
      youtube.startPolling();
    }
  }

  return app;
}

function isPublicPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/health" ||
    path === "/overlay" ||
    path.startsWith("/overlay/") ||
    path.startsWith("/api/overlay/") ||
    path.startsWith("/media/") ||
    path === "/api/youtube/oauth/callback" ||
    path === "/" ||
    path.startsWith("/assets/") ||
    /\.(js|css|map|svg|png|jpg|ico|woff2)$/.test(path)
  );
}

function headerToken(request: FastifyRequest): string | undefined {
  const raw = request.headers["x-chat-director-token"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function queryToken(request: FastifyRequest): string | undefined {
  const token = (request.query as { token?: string }).token;
  return token;
}

function normalizeVideoId(input: string): string {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes("youtu.be")) return url.pathname.replace("/", "");
    const fromQuery = url.searchParams.get("v");
    if (fromQuery) return fromQuery;
  } catch {
    // already an id
  }
  return trimmed;
}

function oauthResultPage(title: string, detail: string): string {
  return `<!doctype html><html><body style="font-family:Georgia;background:#100e0c;color:#eadfca;padding:48px">
    <h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}
