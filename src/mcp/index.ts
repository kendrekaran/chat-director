import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const baseUrl = (process.env.CHAT_DIRECTOR_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.CHAT_DIRECTOR_TOKEN ?? "";

async function directorFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Chat-Director-Token": token,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

const server = new McpServer({
  name: "chat-director",
  version: "1.0.0",
});

server.registerTool(
  "get_session",
  {
    description:
      "Read the persisted story session: setup, limits remaining, bounded unread chat, jobs, and overlay state. Call this first after connecting or when resuming a director session. Does not raise generation limits.",
  },
  async () => {
    const snapshot = await directorFetch("/api/agent/session");
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
  },
);

server.registerTool(
  "wait_for_updates",
  {
    description:
      "Long-poll until the session sequence advances (new chat, job progress, or control changes) or the timeout elapses. Pass the last seen seq from get_session.",
    inputSchema: {
      sinceSeq: z.number().int().nonnegative().describe("Last event sequence number already processed."),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(60_000)
        .optional()
        .describe("How long to wait before returning the current snapshot."),
    },
  },
  async ({ sinceSeq, timeoutMs }) => {
    const query = new URLSearchParams({
      sinceSeq: String(sinceSeq),
      timeoutMs: String(timeoutMs ?? 25_000),
    });
    const snapshot = await directorFetch(`/api/agent/wait?${query.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
  },
);

server.registerTool(
  "submit_scene",
  {
    description:
      "Submit one scene generation. The application enforces session status, one-at-a-time generation, the host submission cap, blocked terms, and story-chat rules. Duplicate proposals are ignored. The agent cannot increase its allowance.",
    inputSchema: {
      prompt: z
        .string()
        .min(1)
        .max(7000)
        .describe("MiniMax H3 video prompt. Do not interpolate untrusted chat as shell text."),
      supportingMessageIds: z
        .array(z.string())
        .default([])
        .describe("YouTube or demo chat message IDs that justified this scene. Required after the opening scene."),
      proposedProgression: z.object({
        summary: z.string().min(1).describe("What this scene establishes for later scenes."),
        events: z.array(z.string()).optional(),
        characterUpdates: z
          .array(z.object({ name: z.string(), description: z.string() }))
          .optional(),
      }),
    },
  },
  async (proposal) => {
    const result = await directorFetch("/api/agent/submit", {
      method: "POST",
      body: JSON.stringify(proposal),
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
