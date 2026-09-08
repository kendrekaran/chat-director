import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../src/server/config.js";

const root = resolve(process.cwd());
const config = loadConfig(root);

function which(bin: string): boolean {
  const result = spawnSync(bin, ["-version"], { encoding: "utf8" });
  if (result.status === 0) return true;
  const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
  return help.status === 0 || help.status === 1;
}

function report(label: string, ok: boolean, detail: string): void {
  const mark = ok ? "ok" : "unverified";
  console.log(`[${mark}] ${label}: ${detail}`);
}

report("ffmpeg", which(config.ffmpegBin), config.ffmpegBin);
report("ffprobe", which(config.ffprobeBin), config.ffprobeBin);

const higgs = spawnSync(config.higgsfieldBin, ["account", "status"], { encoding: "utf8" });
const higgsOk = higgs.status === 0 && !/not authenticated|session expired/i.test(`${higgs.stdout}\n${higgs.stderr}`);
report(
  "higgsfield auth",
  higgsOk,
  higgsOk ? "CLI session looks valid" : "Live MiniMax H3 generation was not smoke-tested (CLI missing or logged out).",
);

const youtubeClient = existsSync(resolve(config.dataDir, "credentials/google-oauth.json"));
const youtubeTokens = existsSync(resolve(config.dataDir, "credentials/youtube-tokens.json"));
report(
  "youtube credentials",
  youtubeClient && youtubeTokens,
  youtubeClient && youtubeTokens
    ? "OAuth client and tokens are present on this machine."
    : "Live YouTube chat was not smoke-tested (no local OAuth client/tokens).",
);

const clips = ["01-lantern-grove.mp4", "02-rain-courtyard.mp4", "03-river-spirit.mp4"].every((name) =>
  existsSync(resolve(config.fixturesDir, "clips", name)),
);
report("demo fixtures", clips, clips ? "Bundled demo clips are present." : "Run npm run fixtures.");

if (process.env.SMOKE_LIVE === "1" && higgsOk) {
  console.log("SMOKE_LIVE=1 is set. Submitting one minimax_h3 job would incur provider cost; refusing to do that implicitly.");
  console.log("Run a manual higgsfield generate create minimax_h3 from your own shell if you want a paid probe.");
}

if (!higgsOk || !youtubeClient || !youtubeTokens) {
  process.exitCode = 0;
}
