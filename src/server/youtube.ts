import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { google, type youtube_v3 } from "googleapis";
import type { ChatDirectorEngine } from "./engine.js";

const YOUTUBE_READONLY = "https://www.googleapis.com/auth/youtube.readonly";

interface OAuthClientFile {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface StoredTokens {
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
}

export class YouTubeChatService {
  private timer: NodeJS.Timeout | null = null;
  private timerArmed = false;
  private inflight = false;

  constructor(
    private readonly engine: ChatDirectorEngine,
    private readonly dataDir: string,
    private readonly publicUrl: string,
  ) {}

  credentialsPath(): string {
    return join(this.dataDir, "credentials", "google-oauth.json");
  }

  tokensPath(): string {
    return join(this.dataDir, "credentials", "youtube-tokens.json");
  }

  hasClient(): boolean {
    return existsSync(this.credentialsPath());
  }

  hasTokens(): boolean {
    return existsSync(this.tokensPath());
  }

  saveClient(clientId: string, clientSecret: string, redirectUri = this.defaultRedirect()): void {
    mkdirSync(join(this.dataDir, "credentials"), { recursive: true });
    const payload: OAuthClientFile = { clientId: clientId.trim(), clientSecret: clientSecret.trim(), redirectUri };
    writeFileSync(this.credentialsPath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
  }

  defaultRedirect(): string {
    return `${this.publicUrl.replace(/\/$/, "")}/api/youtube/oauth/callback`;
  }

  authorizationUrl(): string {
    return this.oauthClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [YOUTUBE_READONLY],
    });
  }

  async handleCallback(code: string): Promise<void> {
    const client = this.oauthClient();
    const { tokens } = await client.getToken(code);
    this.writeTokens(tokens as StoredTokens);
    this.engine.updateYouTube({ lastError: null });
  }

  async connectVideo(videoId: string): Promise<void> {
    const youtube = this.youtube();
    const response = await youtube.videos.list({
      id: [videoId],
      part: ["liveStreamingDetails", "snippet", "status"],
    });
    const video = response.data.items?.[0];
    const liveChatId = video?.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) {
      this.engine.updateYouTube({
        videoId,
        liveChatId: null,
        connected: false,
        chatStatus: "disabled",
        lastError: "This video has no active live chat.",
      });
      throw new Error("This video has no active live chat.");
    }
    this.engine.updateYouTube({
      videoId,
      liveChatId,
      pageToken: null,
      connected: true,
      chatStatus: "idle",
      lastError: null,
    });
  }

  startPolling(): void {
    this.stopPolling();
    const tick = async () => {
      if (this.inflight || !this.timerArmed) return;
      this.inflight = true;
      let waitMs = 5000;
      try {
        waitMs = await this.pollOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : "YouTube poll failed.";
        this.engine.recordError("youtube", message);
        this.engine.updateYouTube({ chatStatus: "error", lastError: message });
      } finally {
        this.inflight = false;
        if (this.timerArmed) {
          this.timer = setTimeout(() => {
            void tick();
          }, waitMs);
        }
      }
    };
    this.timerArmed = true;
    this.timer = setTimeout(() => {
      void tick();
    }, 250);
  }

  stopPolling(): void {
    this.timerArmed = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.inflight = false;
  }

  async pollOnce(): Promise<number> {
    const session = this.engine.requireSession();
    if (session.status !== "running" && session.status !== "paused") return 5000;
    if (!session.youtube.liveChatId) return 5000;
    const youtube = this.youtube();
    try {
      const response = await youtube.liveChatMessages.list({
        liveChatId: session.youtube.liveChatId,
        part: ["id", "snippet", "authorDetails"],
        pageToken: session.youtube.pageToken ?? undefined,
      });
      const interval = response.data.pollingIntervalMillis ?? 5000;
      const nextToken = response.data.nextPageToken ?? session.youtube.pageToken;
      const messages = (response.data.items ?? [])
        .map((item) => toChat(item))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      this.engine.ingestChat(messages);
      this.engine.updateYouTube({
        pageToken: nextToken ?? null,
        chatStatus: "polling",
        lastError: null,
        connected: true,
      });
      return interval;
    } catch (error) {
      const classified = classifyYouTubeError(error);
      this.engine.updateYouTube({
        chatStatus: classified.status,
        lastError: classified.message,
        connected: false,
      });
      if (classified.status === "ended" || classified.status === "disabled") {
        this.engine.recordError("youtube", classified.message);
        this.stopPolling();
        return 60_000;
      }
      throw error;
    }
  }

  status() {
    return {
      hasClient: this.hasClient(),
      hasTokens: this.hasTokens(),
      redirectUri: this.defaultRedirect(),
      scope: YOUTUBE_READONLY,
    };
  }

  private youtube(): youtube_v3.Youtube {
    const auth = this.oauthClient();
    const tokens = this.readTokens();
    if (!tokens) throw new Error("YouTube is not authorized yet.");
    auth.setCredentials(tokens);
    return google.youtube({ version: "v3", auth });
  }

  private oauthClient() {
    const stored = this.readClient();
    if (!stored) throw new Error("Save a Google OAuth client id and secret first.");
    return new google.auth.OAuth2(stored.clientId, stored.clientSecret, stored.redirectUri);
  }

  private readClient(): OAuthClientFile | null {
    if (!this.hasClient()) return null;
    return JSON.parse(readFileSync(this.credentialsPath(), "utf8")) as OAuthClientFile;
  }

  private readTokens(): StoredTokens | null {
    if (!this.hasTokens()) return null;
    return JSON.parse(readFileSync(this.tokensPath(), "utf8")) as StoredTokens;
  }

  private writeTokens(tokens: StoredTokens): void {
    mkdirSync(join(this.dataDir, "credentials"), { recursive: true });
    const previous = this.readTokens() ?? {};
    writeFileSync(
      this.tokensPath(),
      JSON.stringify({ ...previous, ...tokens }, null, 2),
      { mode: 0o600 },
    );
  }
}

function toChat(item: youtube_v3.Schema$LiveChatMessage) {
  const id = item.id;
  const text = item.snippet?.displayMessage ?? item.snippet?.textMessageDetails?.messageText;
  if (!id || !text) return null;
  return {
    id,
    author: item.authorDetails?.displayName ?? "viewer",
    text,
    publishedAt: item.snippet?.publishedAt ?? new Date().toISOString(),
  };
}

export function classifyYouTubeError(error: unknown): {
  status: "disabled" | "ended" | "error";
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const blob = JSON.stringify(error instanceof Error ? { name: error.name, message, stack: error.stack } : error).toLowerCase();
  if (blob.includes("livechatended") || blob.includes("live chat ended")) {
    return { status: "ended", message: "YouTube live chat has ended." };
  }
  if (blob.includes("livechatdisabled") || blob.includes("live chat is disabled")) {
    return { status: "disabled", message: "YouTube live chat is disabled for this broadcast." };
  }
  return { status: "error", message };
}
