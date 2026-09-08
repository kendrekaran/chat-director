import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { GenerationProvider, ProviderPollResult, ProviderSubmitRequest, ProviderSubmitResult } from "./types.js";

export class DemoProvider implements GenerationProvider {
  readonly name = "demo";
  private readonly results = new Map<string, string>();

  constructor(private readonly clipsDir: string) {}

  clipPaths(): string[] {
    if (!existsSync(this.clipsDir)) return [];
    return readdirSync(this.clipsDir)
      .filter((name) => name.endsWith(".mp4"))
      .sort()
      .map((name) => join(this.clipsDir, name));
  }

  async submit(request: ProviderSubmitRequest): Promise<ProviderSubmitResult> {
    const clips = this.clipPaths();
    if (clips.length === 0) {
      return { ok: false, kind: "rejected", error: "Demo clips are missing. Run npm run fixtures." };
    }
    const index = Math.abs(hashCode(request.jobId)) % clips.length;
    const source = clips[index]!;
    this.results.set(request.jobId, source);
    return { ok: true, providerJobId: `demo:${request.jobId}` };
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    const jobId = providerJobId.replace(/^demo:/, "");
    let result = this.results.get(jobId);
    if (!result) {
      const clips = this.clipPaths();
      if (clips.length === 0) {
        return { status: "failed", kind: "ambiguous", error: "Demo clips are missing; not resubmitted." };
      }
      result = clips[Math.abs(hashCode(jobId)) % clips.length]!;
      this.results.set(jobId, result);
    }
    return { status: "succeeded", result };
  }

  seedResult(jobId: string, path: string): void {
    this.results.set(jobId, path);
  }
}

export function copyDemoClip(source: string, destination: string): void {
  copyFileSync(source, destination);
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
