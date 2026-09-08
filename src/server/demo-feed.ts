import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatDirectorEngine } from "./engine.js";

export interface DemoChatLine {
  delayMs: number;
  author: string;
  text: string;
}

export function loadDemoScript(fixturesDir: string): DemoChatLine[] {
  const path = join(fixturesDir, "chat-script.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as DemoChatLine[];
}

export function startDemoChat(engine: ChatDirectorEngine, script: DemoChatLine[]): { stop: () => void } {
  const timers: NodeJS.Timeout[] = [];
  let elapsed = 0;
  script.forEach((line, index) => {
    elapsed += line.delayMs;
    const timer = setTimeout(() => {
      const session = engine.requireSession();
      if (session.status !== "running" && session.status !== "paused") return;
      engine.ingestChat([
        {
          id: `demo-chat-${index + 1}`,
          author: line.author,
          text: line.text,
          publishedAt: engine.nowIso(),
        },
      ]);
    }, elapsed);
    timers.push(timer);
  });
  return {
    stop: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

export function startDemoDirector(engine: ChatDirectorEngine, intervalMs = 2000): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      maybeDirect(engine);
    } catch {
      // Demo director is best-effort and must never crash the host process.
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}

export function maybeDirect(engine: ChatDirectorEngine): boolean {
  const snapshot = engine.getSnapshot();
  if (!snapshot.session.demoAutoDirector) return false;
  if (snapshot.session.mode !== "demo") return false;
  if (snapshot.session.status !== "running") return false;
  if (!snapshot.limits.canSubmit) return false;

  const openingNeeded =
    snapshot.story.readySceneCount === 0 &&
    snapshot.jobs.every((job) => job.status !== "ready" && !["pending", "submitted", "generating", "downloading", "preparing"].includes(job.status));

  if (openingNeeded) {
    const result = engine.submitScene({
      prompt: openingPrompt(snapshot.session.premise, snapshot.session.visualStyle, snapshot.session.characters.map((c) => c.name).join(", ")),
      supportingMessageIds: [],
      proposedProgression: {
        summary: "Opening scene from the host premise.",
        events: ["The story begins."],
      },
    });
    return result.ok && !result.duplicate;
  }

  const unused = snapshot.unreadChat.slice(0, 3);
  if (unused.length === 0) return false;
  const idea = unused.map((message) => message.text).join(" / ");
  const result = engine.submitScene({
    prompt: `${snapshot.session.visualStyle}. Continue the story. Viewer suggestions: ${idea}`.slice(0, 6900),
    supportingMessageIds: unused.map((message) => message.id),
    proposedProgression: {
      summary: `Follow viewer suggestions: ${idea}`.slice(0, 400),
      events: unused.map((message) => `${message.author} suggested: ${message.text}`),
    },
  });
  return result.ok && !result.duplicate;
}

function openingPrompt(premise: string, style: string, characters: string): string {
  return [
    `Cinematic opening scene.`,
    style ? `Visual style: ${style}.` : "",
    characters ? `Characters: ${characters}.` : "",
    `Premise: ${premise}`,
    `Slow establishing camera, readable faces, natural motion, no on-screen text.`,
  ]
    .filter(Boolean)
    .join(" ");
}
