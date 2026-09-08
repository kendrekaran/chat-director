import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { proposalHash } from "../shared/hash.js";
import { findBlockedTerm, screenChatText } from "../shared/moderation.js";
import {
  AGENT_INACTIVE_MS,
  DEFAULT_BOUNDARIES,
  DEFAULT_CHAT_BATCH,
  DEFAULT_LIMITS,
  IN_FLIGHT_JOB_STATUSES,
  MAX_SCENE_DURATION_SEC,
  MAX_SUBMISSIONS_CAP,
  MIN_SCENE_DURATION_SEC,
  type AgentStatus,
  type Character,
  type ChatMessage,
  type ContentBoundaries,
  type GenerationJob,
  type JobStatus,
  type OverlayState,
  type SceneProposal,
  type SelectedIdea,
  type SessionLimits,
  type SessionLimitsView,
  type SessionMode,
  type SessionRecord,
  type SessionSnapshot,
  type SessionStatus,
  type StoryState,
  type YouTubeConnection,
} from "../shared/types.js";

export interface EngineClock {
  now(): Date;
}

export const systemClock: EngineClock = {
  now: () => new Date(),
};

interface SessionRow {
  id: string;
  status: SessionStatus;
  mode: SessionMode;
  premise: string;
  visual_style: string;
  characters_json: string;
  boundaries_json: string;
  limits_json: string;
  youtube_json: string;
  hold: number;
  muted: number;
  demo_auto_director: number;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
  updated_at: string;
}

interface JobRow {
  id: string;
  session_id: string;
  proposal_hash: string;
  status: JobStatus;
  prompt: string;
  supporting_ids_json: string;
  progression_json: string;
  provider_job_id: string | null;
  provider_result_url: string | null;
  source_path: string | null;
  playback_path: string | null;
  last_frame_path: string | null;
  start_image_path: string | null;
  scene_index: number | null;
  error: string | null;
  ambiguous: number;
  created_at: string;
  updated_at: string;
}

interface ChatRow {
  id: string;
  session_id: string;
  author: string;
  text: string;
  published_at: string;
  ingested_at: string;
  flagged: number;
  flagged_term: string | null;
  used_by_job_id: string | null;
}

export type SubmitOutcome =
  | { ok: true; job: GenerationJob; duplicate: false }
  | { ok: true; job: GenerationJob; duplicate: true }
  | { ok: false; error: string; code: SubmitErrorCode };

export type SubmitErrorCode =
  | "session_not_running"
  | "generation_paused"
  | "limit_reached"
  | "limits_immutable"
  | "invalid_proposal"
  | "blocked_term"
  | "opening_required"
  | "need_chat"
  | "concurrent_limit"
  | "unknown_messages";

export interface RecoveryReport {
  markedAmbiguous: string[];
  resumable: string[];
}

export interface IngestResult {
  inserted: ChatMessage[];
  duplicates: string[];
}

const EMPTY_YOUTUBE: YouTubeConnection = {
  videoId: null,
  liveChatId: null,
  pageToken: null,
  connected: false,
  chatStatus: "idle",
  lastError: null,
};

export class ChatDirectorEngine {
  private agentHeartbeatAt: string | null = null;
  private waiters: Array<{ since: number; resolve: (snapshot: SessionSnapshot) => void }> = [];

  constructor(
    private readonly db: Database.Database,
    private readonly clock: EngineClock = systemClock,
  ) {
    this.ensureSession();
  }

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  private ensureSession(): SessionRecord {
    const existing = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1").get() as
      | SessionRow
      | undefined;
    if (existing) return this.sessionFromRow(existing);
    const id = randomUUID();
    const now = this.nowIso();
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, status, mode, premise, visual_style, characters_json, boundaries_json,
          limits_json, youtube_json, hold, muted, demo_auto_director, created_at, updated_at
        ) VALUES (?, 'idle', 'demo', '', '', '[]', ?, ?, ?, 0, 0, 1, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(DEFAULT_BOUNDARIES),
        JSON.stringify(DEFAULT_LIMITS),
        JSON.stringify(EMPTY_YOUTUBE),
        now,
        now,
      );
    this.emit("session", { action: "created" });
    return this.requireSession();
  }

  requireSession(): SessionRecord {
    const row = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1").get() as
      | SessionRow
      | undefined;
    if (!row) throw new Error("session missing");
    return this.sessionFromRow(row);
  }

  getSnapshot(chatLimit = DEFAULT_CHAT_BATCH): SessionSnapshot {
    const session = this.requireSession();
    const jobs = this.listJobs(session.id);
    const chat = this.listChat(session.id, 200);
    const unreadChat = chat
      .filter((message) => !message.usedByJobId && !message.flagged)
      .slice(-chatLimit);
    const story = this.buildStory(session, jobs);
    return {
      seq: this.currentSeq(),
      session,
      story,
      limits: this.limitsView(session, jobs),
      chat: chat.slice(-chatLimit),
      unreadChat,
      jobs,
      errors: this.listErrors(session.id),
      agent: this.agentStatus(),
      overlay: this.overlayState(session, jobs),
      selectedIdeas: this.selectedIdeas(jobs, chat),
    };
  }

  updateSetup(input: {
    premise?: string;
    visualStyle?: string;
    characters?: Character[];
    boundaries?: Partial<ContentBoundaries>;
    limits?: Partial<SessionLimits>;
    demoAutoDirector?: boolean;
  }): SessionRecord {
    const session = this.requireSession();
    if (session.status === "running" || session.status === "paused") {
      if (input.limits && this.limitsChanged(session.limits, input.limits)) {
        throw Object.assign(new Error("Limits can only be edited before starting."), {
          code: "limits_immutable" satisfies SubmitErrorCode,
        });
      }
    }
    const nextLimits = input.limits
      ? sanitizeLimits({ ...session.limits, ...input.limits })
      : session.limits;
    const nextBoundaries = {
      ...session.boundaries,
      ...input.boundaries,
      blockedTerms: (input.boundaries?.blockedTerms ?? session.boundaries.blockedTerms).map((term) =>
        term.trim(),
      ).filter(Boolean),
    };
    const now = this.nowIso();
    this.db
      .prepare(
        `UPDATE sessions SET
          premise = ?, visual_style = ?, characters_json = ?, boundaries_json = ?,
          limits_json = ?, demo_auto_director = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.premise ?? session.premise,
        input.visualStyle ?? session.visualStyle,
        JSON.stringify(input.characters ?? session.characters),
        JSON.stringify(nextBoundaries),
        JSON.stringify(nextLimits),
        input.demoAutoDirector === undefined
          ? session.demoAutoDirector
            ? 1
            : 0
          : input.demoAutoDirector
            ? 1
            : 0,
        now,
        session.id,
      );
    this.emit("setup", {});
    return this.requireSession();
  }

  start(mode: SessionMode): SessionRecord {
    const session = this.requireSession();
    if (session.status === "running" || session.status === "paused") {
      throw new Error("A session is already active. Stop it before starting another.");
    }
    if (!session.premise.trim()) {
      throw new Error("Premise is required before starting.");
    }
    if (mode === "live" && !session.youtube.connected) {
      throw new Error("Connect YouTube live chat before starting a live session.");
    }
    const now = this.nowIso();
    if (session.status === "stopped") {
      this.rotateSession(mode, now);
    } else {
      this.db
        .prepare(
          `UPDATE sessions SET status = 'running', mode = ?, started_at = ?, stopped_at = NULL, hold = 0, updated_at = ? WHERE id = ?`,
        )
        .run(mode, now, now, session.id);
    }
    this.emit("control", { action: "start", mode });
    return this.requireSession();
  }

  pause(): SessionRecord {
    const session = this.requireActive();
    this.db
      .prepare(`UPDATE sessions SET status = 'paused', updated_at = ? WHERE id = ?`)
      .run(this.nowIso(), session.id);
    this.emit("control", { action: "pause" });
    return this.requireSession();
  }

  resume(): SessionRecord {
    const session = this.requireSession();
    if (session.status !== "paused") throw new Error("Session is not paused.");
    this.db
      .prepare(`UPDATE sessions SET status = 'running', updated_at = ? WHERE id = ?`)
      .run(this.nowIso(), session.id);
    this.emit("control", { action: "resume" });
    return this.requireSession();
  }

  stop(): SessionRecord {
    const session = this.requireSession();
    if (session.status === "idle" || session.status === "stopped") {
      return session;
    }
    this.db
      .prepare(`UPDATE sessions SET status = 'stopped', stopped_at = ?, updated_at = ? WHERE id = ?`)
      .run(this.nowIso(), this.nowIso(), session.id);
    this.emit("control", { action: "stop" });
    return this.requireSession();
  }

  setHold(hold: boolean): SessionRecord {
    const session = this.requireSession();
    this.db
      .prepare(`UPDATE sessions SET hold = ?, updated_at = ? WHERE id = ?`)
      .run(hold ? 1 : 0, this.nowIso(), session.id);
    this.emit("control", { action: hold ? "hold" : "release" });
    return this.requireSession();
  }

  setMuted(muted: boolean): SessionRecord {
    const session = this.requireSession();
    this.db
      .prepare(`UPDATE sessions SET muted = ?, updated_at = ? WHERE id = ?`)
      .run(muted ? 1 : 0, this.nowIso(), session.id);
    this.emit("control", { action: muted ? "mute" : "unmute" });
    return this.requireSession();
  }

  updateYouTube(patch: Partial<YouTubeConnection>): YouTubeConnection {
    const session = this.requireSession();
    const next = { ...session.youtube, ...patch };
    this.db
      .prepare(`UPDATE sessions SET youtube_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(next), this.nowIso(), session.id);
    this.emit("youtube", next);
    return next;
  }

  ingestChat(
    incoming: Array<Pick<ChatMessage, "id" | "author" | "text" | "publishedAt">>,
  ): IngestResult {
    const session = this.requireSession();
    const inserted: ChatMessage[] = [];
    const duplicates: string[] = [];
    const now = this.nowIso();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO chat_messages
        (id, session_id, author, text, published_at, ingested_at, flagged, flagged_term)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of incoming) {
      const screen = screenChatText(message.text, session.boundaries.blockedTerms);
      const result = insert.run(
        message.id,
        session.id,
        message.author,
        message.text,
        message.publishedAt,
        now,
        screen.flagged ? 1 : 0,
        screen.flaggedTerm,
      );
      if (result.changes === 0) {
        duplicates.push(message.id);
        continue;
      }
      inserted.push({
        id: message.id,
        author: message.author,
        text: message.text,
        publishedAt: message.publishedAt,
        ingestedAt: now,
        flagged: screen.flagged,
        flaggedTerm: screen.flaggedTerm,
        usedByJobId: null,
      });
    }
    if (inserted.length > 0) this.emit("chat", { count: inserted.length });
    return { inserted, duplicates };
  }

  submitScene(proposal: SceneProposal): SubmitOutcome {
    const session = this.requireSession();
    if (session.status === "stopped" || session.status === "idle") {
      return { ok: false, error: "Session is not running.", code: "session_not_running" };
    }
    if (session.status === "paused") {
      return { ok: false, error: "Generation is paused.", code: "generation_paused" };
    }

    const trimmedPrompt = proposal.prompt?.trim() ?? "";
    const summary = proposal.proposedProgression?.summary?.trim() ?? "";
    if (!trimmedPrompt || !summary) {
      return { ok: false, error: "Prompt and progression summary are required.", code: "invalid_proposal" };
    }
    if (trimmedPrompt.length > 7000) {
      return { ok: false, error: "Prompt exceeds 7000 characters.", code: "invalid_proposal" };
    }

    const blocked = findBlockedTerm(trimmedPrompt, session.boundaries.blockedTerms);
    if (blocked) {
      return { ok: false, error: `Prompt contains a blocked term (${blocked}).`, code: "blocked_term" };
    }

    const jobs = this.listJobs(session.id);
    const limits = this.limitsView(session, jobs);
    const hash = proposalHash({
      prompt: trimmedPrompt,
      supportingMessageIds: proposal.supportingMessageIds,
      proposedProgression: { ...proposal.proposedProgression, summary },
    });
    const existing = jobs.find((job) => job.proposalHash === hash);
    if (existing) {
      return { ok: true, job: existing, duplicate: true };
    }
    if (!limits.canSubmit) {
      return {
        ok: false,
        error: `Submission limit reached (${limits.submissionsUsed}/${limits.maxSubmissions}). The agent cannot raise this allowance.`,
        code: "limit_reached",
      };
    }

    const inFlight = jobs.filter((job) => IN_FLIGHT_JOB_STATUSES.includes(job.status));
    if (inFlight.length >= session.limits.maxConcurrent) {
      return {
        ok: false,
        error: "A generation is already in progress. Wait for it to finish.",
        code: "concurrent_limit",
      };
    }

    const readyCount = jobs.filter((job) => job.status === "ready").length;
    const supporting = this.lookupMessages(session.id, proposal.supportingMessageIds);
    if (supporting.missing.length > 0) {
      return {
        ok: false,
        error: `Unknown supporting message IDs: ${supporting.missing.join(", ")}`,
        code: "unknown_messages",
      };
    }
    if (readyCount === 0 && jobs.every((job) => job.status !== "ready" && !IN_FLIGHT_JOB_STATUSES.includes(job.status))) {
      // opening scene — chat optional
    } else if (readyCount > 0 || inFlight.length > 0) {
      const unused = supporting.found.filter((message) => !message.usedByJobId && !message.flagged);
      if (unused.length === 0) {
        return {
          ok: false,
          error: "No unused viewer suggestions selected. Wait for suitable chat before the next scene.",
          code: "need_chat",
        };
      }
    }

    const now = this.nowIso();
    const id = randomUUID();
    const startImagePath = this.buildStory(session, jobs).lastFramePath;
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, session_id, proposal_hash, status, prompt, supporting_ids_json, progression_json,
          start_image_path, error, ambiguous, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, 0, ?, ?)`,
      )
      .run(
        id,
        session.id,
        hash,
        trimmedPrompt,
        JSON.stringify(proposal.supportingMessageIds),
        JSON.stringify({ ...proposal.proposedProgression, summary }),
        startImagePath,
        now,
        now,
      );
    this.emit("job", { id, status: "pending" });
    return { ok: true, job: this.requireJob(id), duplicate: false };
  }

  claimNextWork(): GenerationJob | null {
    const session = this.requireSession();
    const jobs = this.listJobs(session.id);
    const known = jobs.find((job) =>
      ["submitted", "generating", "downloading", "preparing"].includes(job.status),
    );
    if (known) return known;
    if (session.status !== "running") return null;
    return jobs.find((job) => job.status === "pending") ?? null;
  }

  markSubmitted(jobId: string, providerJobId: string): GenerationJob {
    return this.patchJob(jobId, {
      status: "submitted",
      provider_job_id: providerJobId,
    });
  }

  markGenerating(jobId: string): GenerationJob {
    return this.patchJob(jobId, { status: "generating" });
  }

  markDownloading(jobId: string, resultUrl: string): GenerationJob {
    return this.patchJob(jobId, {
      status: "downloading",
      provider_result_url: resultUrl,
    });
  }

  markPreparing(jobId: string, sourcePath: string): GenerationJob {
    return this.patchJob(jobId, { status: "preparing", source_path: sourcePath });
  }

  markRejected(jobId: string, error: string): GenerationJob {
    return this.patchJob(jobId, { status: "rejected", error });
  }

  markFailed(jobId: string, error: string): GenerationJob {
    return this.patchJob(jobId, { status: "failed", error });
  }

  markAmbiguous(jobId: string, error: string): GenerationJob {
    this.recordError("provider", error);
    return this.patchJob(jobId, { status: "ambiguous", error, ambiguous: 1 });
  }

  completePrepared(
    jobId: string,
    paths: { playbackPath: string; lastFramePath: string; sourcePath: string },
  ): GenerationJob {
    const session = this.requireSession();
    const job = this.requireJob(jobId);
    const readyCount = this.listJobs(session.id).filter((item) => item.status === "ready").length;
    const sceneIndex = readyCount + 1;
    const now = this.nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE jobs SET
            status = 'ready', source_path = ?, playback_path = ?, last_frame_path = ?,
            scene_index = ?, error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(paths.sourcePath, paths.playbackPath, paths.lastFramePath, sceneIndex, now, jobId);
      this.db
        .prepare(
          `INSERT INTO scene_summaries (id, session_id, scene_index, summary, job_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), session.id, sceneIndex, job.proposedProgression.summary, jobId, now);
      for (const event of job.proposedProgression.events ?? []) {
        this.db
          .prepare(
            `INSERT INTO story_events (id, session_id, text, scene_index, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(randomUUID(), session.id, event, sceneIndex, now);
      }
      this.applyCharacterUpdates(session, job.proposedProgression.characterUpdates ?? [], now);
      if (job.supportingMessageIds.length > 0) {
        const placeholders = job.supportingMessageIds.map(() => "?").join(",");
        this.db
          .prepare(
            `UPDATE chat_messages SET used_by_job_id = ? WHERE session_id = ? AND id IN (${placeholders})`,
          )
          .run(jobId, session.id, ...job.supportingMessageIds);
      }
    })();
    this.emit("story", { jobId, sceneIndex });
    return this.requireJob(jobId);
  }

  recoverOnBoot(): RecoveryReport {
    const session = this.requireSession();
    const jobs = this.listJobs(session.id);
    const markedAmbiguous: string[] = [];
    const resumable: string[] = [];
    for (const job of jobs) {
      if (job.status === "pending" && !job.providerJobId) {
        this.markAmbiguous(
          job.id,
          "Interrupted before the provider accepted the request. Not resubmitted.",
        );
        markedAmbiguous.push(job.id);
        continue;
      }
      if (["submitted", "generating", "downloading", "preparing"].includes(job.status)) {
        resumable.push(job.id);
      }
    }
    if (markedAmbiguous.length || resumable.length) {
      this.emit("recovery", { markedAmbiguous, resumable });
    }
    return { markedAmbiguous, resumable };
  }

  recordError(source: string, message: string): void {
    const session = this.requireSession();
    this.db
      .prepare(
        `INSERT INTO errors (id, session_id, source, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), session.id, source, message, this.nowIso());
    this.emit("error", { source, message });
  }

  recordAgentHeartbeat(): void {
    this.agentHeartbeatAt = this.nowIso();
    this.emit("agent", { connected: true });
  }

  agentStatus(): AgentStatus {
    if (!this.agentHeartbeatAt) {
      return {
        connected: false,
        lastHeartbeatAt: null,
        inactiveNotice: "No Codex or Cursor director is connected. Playback can continue from persisted scenes.",
      };
    }
    const age = this.clock.now().getTime() - Date.parse(this.agentHeartbeatAt);
    const connected = age <= AGENT_INACTIVE_MS;
    return {
      connected,
      lastHeartbeatAt: this.agentHeartbeatAt,
      inactiveNotice: connected
        ? null
        : "Director agent is inactive. Playback keeps running. Reconnect Codex or Cursor to resume scene selection.",
    };
  }

  currentSeq(): number {
    const row = this.db.prepare("SELECT IFNULL(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  async waitForUpdates(sinceSeq: number, timeoutMs = 25_000): Promise<SessionSnapshot> {
    if (this.currentSeq() > sinceSeq) {
      return this.getSnapshot();
    }
    return await new Promise((resolve) => {
      const waiter = { since: sinceSeq, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        resolve(this.getSnapshot());
      }, timeoutMs);
      const original = waiter.resolve;
      waiter.resolve = (snapshot) => {
        clearTimeout(timer);
        original(snapshot);
      };
    });
  }

  overlayState(session = this.requireSession(), jobs = this.listJobs(session.id)): OverlayState {
    const ready = jobs
      .filter((job) => job.status === "ready" && job.sceneIndex !== null && job.playbackPath)
      .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
    const current = ready.at(-1) ?? null;
    const previous = ready.length > 1 ? ready[ready.length - 2] : null;
    const playing = current
      ? {
          jobId: current.id,
          sceneIndex: current.sceneIndex ?? 0,
          playbackUrl: `/media/scenes/${current.id}/playback.mp4`,
        }
      : null;
    // Overlay loops the latest ready scene. The previous ready clip is only
    // useful while the latest is still preparing — expose it as current when
    // we want seamless switch: current is the latest the player should be on,
    // next is a newer clip the player has not switched to yet. The player
    // owns that distinction; the API always reports latest as current and
    // leaves next null unless a newer ready scene appeared after the client
    // last acknowledged. We keep next as null here and let the client treat
    // a newer current id as next.
    return {
      hold: session.hold || !playing,
      muted: session.muted,
      sessionStatus: session.status,
      current: playing,
      next: previous && !current ? {
        jobId: previous.id,
        sceneIndex: previous.sceneIndex ?? 0,
        playbackUrl: `/media/scenes/${previous.id}/playback.mp4`,
      } : null,
      waitingForFirstScene: !playing,
    };
  }

  /**
   * Playlist for the overlay client: ready scenes in story order.
   * The client plays the last item on a loop and preloads a newly appended item.
   */
  readyPlaylist(): OverlayState & { playlist: OverlayState["current"][] } {
    const session = this.requireSession();
    const jobs = this.listJobs(session.id);
    const ready = jobs
      .filter((job) => job.status === "ready" && job.sceneIndex !== null)
      .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0))
      .map((job) => ({
        jobId: job.id,
        sceneIndex: job.sceneIndex ?? 0,
        playbackUrl: `/media/scenes/${job.id}/playback.mp4`,
      }));
    const current = ready.at(-1) ?? null;
    const next = null;
    return {
      ...this.overlayState(session, jobs),
      current,
      next,
      playlist: ready,
    };
  }

  private rotateSession(mode: SessionMode, now: string): void {
    const previous = this.requireSession();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, status, mode, premise, visual_style, characters_json, boundaries_json,
          limits_json, youtube_json, hold, muted, demo_auto_director, created_at, started_at, updated_at
        ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        mode,
        previous.premise,
        previous.visualStyle,
        JSON.stringify(previous.characters),
        JSON.stringify(previous.boundaries),
        JSON.stringify(previous.limits),
        JSON.stringify({ ...EMPTY_YOUTUBE, videoId: previous.youtube.videoId }),
        previous.demoAutoDirector ? 1 : 0,
        now,
        now,
        now,
      );
  }

  private requireActive(): SessionRecord {
    const session = this.requireSession();
    if (session.status !== "running" && session.status !== "paused") {
      throw new Error("No active session.");
    }
    return session;
  }

  private limitsChanged(current: SessionLimits, patch: Partial<SessionLimits>): boolean {
    return Object.entries(patch).some(([key, value]) => current[key as keyof SessionLimits] !== value);
  }

  private limitsView(session: SessionRecord, jobs: GenerationJob[]): SessionLimitsView {
    const submissionsUsed = jobs.length;
    const remaining = Math.max(0, session.limits.maxSubmissions - submissionsUsed);
    return {
      ...session.limits,
      submissionsUsed,
      remaining,
      canSubmit: remaining > 0,
      locked: session.status === "running" || session.status === "paused",
    };
  }

  private buildStory(session: SessionRecord, jobs: GenerationJob[]): StoryState {
    const summaries = this.db
      .prepare(
        `SELECT scene_index, summary, job_id, created_at FROM scene_summaries
         WHERE session_id = ? ORDER BY scene_index ASC`,
      )
      .all(session.id) as Array<{
      scene_index: number;
      summary: string;
      job_id: string;
      created_at: string;
    }>;
    const events = this.db
      .prepare(
        `SELECT text FROM story_events WHERE session_id = ? ORDER BY scene_index ASC, created_at ASC`,
      )
      .all(session.id) as Array<{ text: string }>;
    const lastReady = [...jobs]
      .filter((job) => job.status === "ready")
      .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0))
      .at(-1);
    return {
      premise: session.premise,
      visualStyle: session.visualStyle,
      characters: session.characters,
      establishedEvents: events.map((event) => event.text),
      sceneSummaries: summaries.map((row) => ({
        sceneIndex: row.scene_index,
        summary: row.summary,
        jobId: row.job_id,
        createdAt: row.created_at,
      })),
      lastFramePath: lastReady?.lastFramePath ?? null,
      readySceneCount: summaries.length,
    };
  }

  private applyCharacterUpdates(session: SessionRecord, updates: Character[], now: string): void {
    if (updates.length === 0) return;
    const map = new Map(session.characters.map((character) => [character.name.toLowerCase(), character]));
    for (const update of updates) {
      map.set(update.name.toLowerCase(), { name: update.name, description: update.description });
    }
    this.db
      .prepare(`UPDATE sessions SET characters_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify([...map.values()]), now, session.id);
  }

  private selectedIdeas(jobs: GenerationJob[], chat: ChatMessage[]): SelectedIdea[] {
    const byId = new Map(chat.map((message) => [message.id, message]));
    return jobs
      .slice()
      .reverse()
      .map((job) => ({
        jobId: job.id,
        prompt: job.prompt,
        supportingMessages: job.supportingMessageIds
          .map((id) => byId.get(id))
          .filter((message): message is ChatMessage => Boolean(message)),
        status: job.status,
        createdAt: job.createdAt,
      }));
  }

  listJobs(sessionId: string): GenerationJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as JobRow[];
    return rows.map(jobFromRow);
  }

  private listChat(sessionId: string, limit: number): ChatMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY published_at ASC, ingested_at ASC LIMIT ?`,
      )
      .all(sessionId, limit) as ChatRow[];
    return rows.map(chatFromRow);
  }

  private listErrors(sessionId: string) {
    return (
      this.db
        .prepare(
          `SELECT id, source, message, created_at FROM errors WHERE session_id = ? ORDER BY created_at DESC LIMIT 50`,
        )
        .all(sessionId) as Array<{ id: string; source: string; message: string; created_at: string }>
    ).map((row) => ({
      id: row.id,
      source: row.source,
      message: row.message,
      createdAt: row.created_at,
    }));
  }

  private lookupMessages(sessionId: string, ids: string[]): { found: ChatMessage[]; missing: string[] } {
    if (ids.length === 0) return { found: [], missing: [] };
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM chat_messages WHERE session_id = ? AND id IN (${placeholders})`)
      .all(sessionId, ...ids) as ChatRow[];
    const found = rows.map(chatFromRow);
    const have = new Set(found.map((message) => message.id));
    return { found, missing: ids.filter((id) => !have.has(id)) };
  }

  requireJob(id: string): GenerationJob {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) throw new Error(`Unknown job ${id}`);
    return jobFromRow(row);
  }

  private patchJob(
    jobId: string,
    fields: Partial<{
      status: JobStatus;
      provider_job_id: string | null;
      provider_result_url: string | null;
      source_path: string | null;
      playback_path: string | null;
      last_frame_path: string | null;
      error: string | null;
      ambiguous: number;
    }>,
  ): GenerationJob {
    const now = this.nowIso();
    const assignments = Object.keys(fields)
      .map((key) => `${key} = ?`)
      .join(", ");
    this.db
      .prepare(`UPDATE jobs SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(fields), now, jobId);
    this.emit("job", { id: jobId, status: fields.status });
    return this.requireJob(jobId);
  }

  private emit(type: string, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(this.requireSession().id, type, JSON.stringify(payload), this.nowIso());
    const snapshot = this.getSnapshot();
    const remaining: typeof this.waiters = [];
    for (const waiter of this.waiters) {
      if (snapshot.seq > waiter.since) waiter.resolve(snapshot);
      else remaining.push(waiter);
    }
    this.waiters = remaining;
  }

  private sessionFromRow(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      status: row.status,
      mode: row.mode,
      premise: row.premise,
      visualStyle: row.visual_style,
      characters: JSON.parse(row.characters_json) as Character[],
      boundaries: JSON.parse(row.boundaries_json) as ContentBoundaries,
      limits: JSON.parse(row.limits_json) as SessionLimits,
      youtube: JSON.parse(row.youtube_json) as YouTubeConnection,
      hold: Boolean(row.hold),
      muted: Boolean(row.muted),
      demoAutoDirector: Boolean(row.demo_auto_director),
      createdAt: row.created_at,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      updatedAt: row.updated_at,
    };
  }
}

function jobFromRow(row: JobRow): GenerationJob {
  return {
    id: row.id,
    sessionId: row.session_id,
    proposalHash: row.proposal_hash,
    status: row.status,
    prompt: row.prompt,
    supportingMessageIds: JSON.parse(row.supporting_ids_json) as string[],
    proposedProgression: JSON.parse(row.progression_json),
    providerJobId: row.provider_job_id,
    providerResultUrl: row.provider_result_url,
    sourcePath: row.source_path,
    playbackPath: row.playback_path,
    lastFramePath: row.last_frame_path,
    startImagePath: row.start_image_path,
    sceneIndex: row.scene_index,
    error: row.error,
    ambiguous: Boolean(row.ambiguous),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function chatFromRow(row: ChatRow): ChatMessage {
  return {
    id: row.id,
    author: row.author,
    text: row.text,
    publishedAt: row.published_at,
    ingestedAt: row.ingested_at,
    flagged: Boolean(row.flagged),
    flaggedTerm: row.flagged_term,
    usedByJobId: row.used_by_job_id,
  };
}

export function sanitizeLimits(input: SessionLimits): SessionLimits {
  const duration = clamp(
    Math.round(input.sceneDurationSec || DEFAULT_LIMITS.sceneDurationSec),
    MIN_SCENE_DURATION_SEC,
    MAX_SCENE_DURATION_SEC,
  );
  const maxSubmissions = clamp(
    Math.round(input.maxSubmissions || DEFAULT_LIMITS.maxSubmissions),
    1,
    MAX_SUBMISSIONS_CAP,
  );
  return {
    sceneDurationSec: duration,
    aspectRatio: "16:9",
    resolution: "2K",
    maxConcurrent: 1,
    maxSubmissions,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
