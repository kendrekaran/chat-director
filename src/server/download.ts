import { copyFileSync, createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

export async function materializeSource(result: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  if (existsSync(result) && !/^https?:\/\//.test(result)) {
    copyFileSync(result, destination);
    return destination;
  }
  if (!/^https?:\/\//.test(result)) {
    throw new Error("Provider result is neither a local file nor an HTTP URL.");
  }
  const response = await fetch(result);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status})`);
  }
  await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(destination));
  return destination;
}
