import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  controlToken: string;
  higgsfieldBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  fixturesDir: string;
}

export function loadConfig(rootDir = process.cwd()): AppConfig {
  const dataDir = resolve(process.env.CHAT_DIRECTOR_DATA_DIR ?? join(rootDir, "data"));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "media"), { recursive: true });
  mkdirSync(join(dataDir, "credentials"), { recursive: true });
  const host = process.env.CHAT_DIRECTOR_HOST ?? "127.0.0.1";
  const port = Number(process.env.CHAT_DIRECTOR_PORT ?? 8787);
  return {
    host,
    port,
    publicUrl: process.env.CHAT_DIRECTOR_PUBLIC_URL ?? `http://${host}:${port}`,
    dataDir,
    controlToken: resolveControlToken(dataDir),
    higgsfieldBin: process.env.CHAT_DIRECTOR_HIGGSFIELD_BIN ?? "higgsfield",
    ffmpegBin: process.env.CHAT_DIRECTOR_FFMPEG ?? "ffmpeg",
    ffprobeBin: process.env.CHAT_DIRECTOR_FFPROBE ?? "ffprobe",
    fixturesDir: resolve(rootDir, "fixtures/demo"),
  };
}

function resolveControlToken(dataDir: string): string {
  if (process.env.CHAT_DIRECTOR_TOKEN?.trim()) {
    return process.env.CHAT_DIRECTOR_TOKEN.trim();
  }
  const tokenPath = join(dataDir, "control-token");
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, "utf8").trim();
  }
  const token = randomBytes(24).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}
