import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { EngineError } from "../errors.js";
import { runFFmpeg } from "../media/process.js";
/** Independent CPU workers render lossless BGRA chunks. Stream-copy concatenation followed by
 * one final encode avoids H.264 GOP/quantizer changes at chunk boundaries. */
export async function renderChunks(
  document: unknown,
  baseDir: string,
  dir: string,
  start: number,
  end: number,
  count: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
  videoCacheBytes?: number,
) {
  const js = new URL("./chunk-worker.js", import.meta.url);
  const ts = new URL("./chunk-worker.ts", import.meta.url);
  // The MCP bundle ships the worker separately alongside the bundle.
  const bundled = new URL("./video-chunk-worker.mjs", import.meta.url);
  const entry = syncFs.existsSync(js)
    ? js
    : syncFs.existsSync(bundled)
      ? bundled
      : new URL(
          "data:text/javascript," +
            encodeURIComponent(
              `import { tsImport } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; await tsImport(${JSON.stringify(ts.href)}, ${JSON.stringify(import.meta.url)});`,
            ),
        );
  const workers: Worker[] = [],
    progresses = Array(count).fill(0);
  const cancel = () => workers.forEach((w) => w.postMessage("abort"));
  if (signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Render cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const promises: Promise<void>[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const from = start + Math.floor(((end - start) * i) / count),
        to = start + Math.floor(((end - start) * (i + 1)) / count);
      const w = new Worker(entry, {
        workerData: { document, baseDir, videoCacheBytes, start: from, end: to, out: path.join(dir, `chunk${i}.mkv`) },
      });
      workers.push(w);
      const completion = new Promise<void>((resolve, reject) => {
        let done = false,
          failure: string | undefined;
        w.on("message", (message) => {
          if (message.progress) {
            progresses[i] = message.progress;
            onProgress?.(
              progresses.reduce((a, b) => a + b, 0),
              end - start,
            );
          }
          if (message.done) done = true;
          if (message.error) {
            failure = message.error;
            cancel();
          }
        });
        w.on("error", (e) => {
          failure = e instanceof Error ? e.message : String(e);
          cancel();
        });
        w.on("exit", (code) =>
          done && code === 0
            ? resolve()
            : reject(new EngineError(signal?.aborted ? "RENDER_CANCELLED" : "RENDER_FAILED", failure ?? `Chunk worker exited ${code}`)),
        );
      });
      void completion.catch(() => undefined);
      promises.push(completion);
    }
    const results = await Promise.allSettled(promises);
    const failed = results.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Render cancelled");
    await fs.writeFile(path.join(dir, "concat.txt"), Array.from({ length: count }, (_, i) => `file chunk${i}.mkv`).join("\n") + "\n");
    const out = path.join(dir, "joined.mkv");
    await runFFmpeg(
      ["-nostdin", "-v", "error", "-f", "concat", "-safe", "1", "-i", "concat.txt", "-map", "0:v:0", "-c", "copy", "-y", "joined.mkv"],
      signal,
      dir,
    );
    return out;
  } catch (e) {
    cancel();
    await Promise.allSettled(promises);
    throw e;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
