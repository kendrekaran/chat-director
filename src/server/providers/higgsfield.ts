import { spawn } from "node:child_process";
import type { GenerationProvider, ProviderPollResult, ProviderSubmitRequest, ProviderSubmitResult } from "./types.js";

export class HiggsfieldProvider implements GenerationProvider {
  readonly name = "higgsfield";

  constructor(private readonly binary: string) {}

  async submit(request: ProviderSubmitRequest): Promise<ProviderSubmitResult> {
    const args = [
      "generate",
      "create",
      "minimax_h3",
      "--prompt",
      request.prompt,
      "--duration",
      String(request.durationSec),
      "--aspect_ratio",
      "16:9",
      "--resolution",
      "2K",
      "--json",
    ];
    if (request.startImagePath) {
      args.push("--start-image", request.startImagePath);
    }

    try {
      const { stdout, stderr, code } = await runArgv(this.binary, args, 60_000);
      const parsed = parseHiggsfieldPayload(stdout);
      const jobId = extractJobId(parsed);
      if (jobId) {
        return { ok: true, providerJobId: jobId };
      }
      if (looksLikeRejection(stdout, stderr, code)) {
        return {
          ok: false,
          kind: "rejected",
          error: firstLine(stderr || stdout) || `Higgsfield rejected the request (exit ${code}).`,
        };
      }
      return {
        ok: false,
        kind: "ambiguous",
        error:
          firstLine(stderr || stdout) ||
          "Higgsfield returned no job id. The paid request was not retried.",
      };
    } catch (error) {
      return {
        ok: false,
        kind: "ambiguous",
        error: error instanceof Error ? error.message : "Higgsfield submit failed before a job id was known.",
      };
    }
  }

  async poll(providerJobId: string): Promise<ProviderPollResult> {
    try {
      const { stdout, stderr, code } = await runArgv(
        this.binary,
        ["generate", "get", providerJobId, "--json"],
        30_000,
      );
      const parsed = parseHiggsfieldPayload(stdout);
      const status = extractStatus(parsed);
      if (status === "succeeded" || status === "completed" || status === "success") {
        const result = extractResultUrl(parsed);
        if (!result) {
          return { status: "failed", kind: "ambiguous", error: "Completed job had no result URL." };
        }
        return { status: "succeeded", result };
      }
      if (status === "failed" || status === "error" || status === "rejected") {
        return {
          status: "failed",
          kind: status === "rejected" ? "rejected" : "failed",
          error: extractError(parsed) || firstLine(stderr) || "Higgsfield generation failed.",
        };
      }
      if (code !== 0 && !status) {
        return {
          status: "failed",
          kind: "ambiguous",
          error: firstLine(stderr || stdout) || `higgsfield generate get exited ${code}.`,
        };
      }
      return { status: "running" };
    } catch (error) {
      return {
        status: "failed",
        kind: "ambiguous",
        error: error instanceof Error ? error.message : "Failed to poll Higgsfield job.",
      };
    }
  }
}

export function parseHiggsfieldPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");
    const idx = start === -1 ? arrayStart : arrayStart === -1 ? start : Math.min(start, arrayStart);
    if (idx === -1) return null;
    try {
      return JSON.parse(trimmed.slice(idx));
    } catch {
      return null;
    }
  }
}

export function extractJobId(payload: unknown): string | null {
  if (!payload) return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractJobId(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["id", "job_id", "jobId", "request_id"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  if (Array.isArray(record.jobs)) return extractJobId(record.jobs);
  if (record.job) return extractJobId(record.job);
  if (record.data) return extractJobId(record.data);
  return null;
}

export function extractStatus(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractStatus(item);
      if (found) return found;
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const status = record.status ?? record.state ?? record.job_status;
  if (typeof status === "string") return status.toLowerCase();
  return extractStatus(record.job ?? record.data ?? record.jobs);
}

export function extractResultUrl(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === "string" && /^https?:\/\//.test(payload)) return payload;
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = extractResultUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["url", "result_url", "video_url", "raw_url"]) {
    if (typeof record[key] === "string" && /^https?:\/\//.test(record[key])) return record[key];
  }
  for (const key of ["results", "artifacts", "outputs", "data", "job", "jobs"]) {
    const found = extractResultUrl(record[key]);
    if (found) return found;
  }
  return null;
}

function extractError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "detail"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function looksLikeRejection(stdout: string, stderr: string, code: number): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/invalid|rejected|nsfw|safety|content policy|missing required/.test(text)) return true;
  return code !== 0 && /400|422/.test(text);
}

function firstLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
}

export function runArgv(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out running ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
