import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { loadDemoScript } from "./demo-feed.js";
import { ChatDirectorEngine } from "./engine.js";
import { createApp } from "./http.js";
import { DemoProvider } from "./providers/demo.js";
import { HiggsfieldProvider } from "./providers/higgsfield.js";
import { YouTubeChatService } from "./youtube.js";

const rootDir = resolve(process.env.CHAT_DIRECTOR_ROOT ?? process.cwd());
const config = loadConfig(rootDir);
const db = openDatabase(config.dataDir);
const engine = new ChatDirectorEngine(db);
const recovery = engine.recoverOnBoot();
const youtube = new YouTubeChatService(engine, config.dataDir, config.publicUrl);
const demoProvider = new DemoProvider(resolve(config.fixturesDir, "clips"));
const higgsfield = new HiggsfieldProvider(config.higgsfieldBin);

const app = await createApp({
  config,
  engine,
  youtube,
  rootDir,
  demoScript: loadDemoScript(config.fixturesDir),
  providerFor: (mode) => (mode === "demo" ? demoProvider : higgsfield),
});

await app.listen({ host: config.host, port: config.port });

app.log.info(
  {
    url: config.publicUrl,
    overlay: `${config.publicUrl}/overlay`,
    tokenFile: `${config.dataDir}/control-token`,
    recovery,
  },
  "Chat Director is bound to localhost. Control endpoints require X-Chat-Director-Token.",
);
