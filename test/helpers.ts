import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.js";
import { ChatDirectorEngine, type EngineClock } from "../src/server/engine.js";
import type { GenerationProvider, ProviderPollResult, ProviderSubmitRequest, ProviderSubmitResult } from "../src/server/providers/types.js";
import type { SceneProposal } from "../src/shared/types.js";

export function tempEngine(clock?: EngineClock) {
  const dir = mkdtempSync(join(tmpdir(), "chat-director-"));
  const db = openDatabase(dir);
  const engine = new ChatDirectorEngine(db, clock);
  return {
    dir,
    db,
    engine,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function openingProposal(overrides: Partial<SceneProposal> = {}): SceneProposal {
  return {
    prompt: "Opening lantern grove, slow dolly, amber night.",
    supportingMessageIds: [],
    proposedProgression: {
      summary: "The fox lights the first street.",
      events: ["Kiyo steps onto the flooded steps."],
    },
    ...overrides,
  };
}

export class MockProvider implements GenerationProvider {
  readonly name = "mock";
  submits: ProviderSubmitRequest[] = [];
  nextSubmit: ProviderSubmitResult = { ok: true, providerJobId: "prov-1" };
  nextPoll: ProviderPollResult = { status: "succeeded", result: "/tmp/missing.mp4" };
  pollCounts = new Map<string, number>();

  async submit(request: ProviderSubmitRequest): Promise<ProviderSubmitResult> {
    this.submits.push(request);
    return this.nextSubmit;
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    this.pollCounts.set(providerJobId, (this.pollCounts.get(providerJobId) ?? 0) + 1);
    return this.nextPoll;
  }
}

export class ControllableClock implements EngineClock {
  constructor(private value: Date) {}
  now(): Date {
    return this.value;
  }
  advance(ms: number): void {
    this.value = new Date(this.value.getTime() + ms);
  }
}
