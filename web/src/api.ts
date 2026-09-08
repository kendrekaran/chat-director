import type { SessionSnapshot } from "@shared";

const TOKEN_KEY = "chat-director-token";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Chat-Director-Token": getToken(),
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({ error: `HTTP ${response.status}` }))) as T & {
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return body;
}

export const api = {
  session: () => request<SessionSnapshot>("/api/session"),
  setup: (body: unknown) => request<SessionSnapshot>("/api/session/setup", { method: "PATCH", body: JSON.stringify(body) }),
  start: (mode: "demo" | "live") =>
    request<SessionSnapshot>("/api/session/start", { method: "POST", body: JSON.stringify({ mode }) }),
  pause: () => request<SessionSnapshot>("/api/session/pause", { method: "POST" }),
  resume: () => request<SessionSnapshot>("/api/session/resume", { method: "POST" }),
  stop: () => request<SessionSnapshot>("/api/session/stop", { method: "POST" }),
  hold: (hold: boolean) =>
    request<SessionSnapshot>("/api/session/hold", { method: "POST", body: JSON.stringify({ hold }) }),
  mute: (muted: boolean) =>
    request<SessionSnapshot>("/api/session/mute", { method: "POST", body: JSON.stringify({ muted }) }),
  inject: (text: string, author = "host") =>
    request<SessionSnapshot>("/api/demo/inject", { method: "POST", body: JSON.stringify({ text, author }) }),
  youtubeStatus: () =>
    request<{
      hasClient: boolean;
      hasTokens: boolean;
      redirectUri: string;
      connection: SessionSnapshot["session"]["youtube"];
    }>("/api/youtube/status"),
  saveYoutubeClient: (clientId: string, clientSecret: string) =>
    request<{ authorizationUrl: string; redirectUri: string }>("/api/youtube/client", {
      method: "POST",
      body: JSON.stringify({ clientId, clientSecret }),
    }),
  youtubeAuthUrl: () => request<{ authorizationUrl: string }>("/api/youtube/oauth/start"),
  connectVideo: (videoId: string) =>
    request<SessionSnapshot>("/api/youtube/connect", { method: "POST", body: JSON.stringify({ videoId }) }),
};

export function openEventStream(onSnapshot: (snapshot: SessionSnapshot) => void): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  source.onmessage = (event) => {
    try {
      onSnapshot(JSON.parse(event.data) as SessionSnapshot);
    } catch {
      // ignore
    }
  };
  return () => source.close();
}
