import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { EngineError } from "../errors.js";
import { ffmpegPath } from "../render/video.js";
const require = createRequire(import.meta.url);
export function ffprobePath(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    return require("ffprobe-static").path;
  } catch {
    return "ffprobe";
  }
}
export function hashFile(file: string): string {
  const fd = fs.openSync(file, "r"),
    hash = createHash("sha256"),
    buf = Buffer.alloc(1024 * 1024);
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null))) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}
export function probeMedia(file: string, countFrames = false): any {
  const r = spawnSync(
    ffprobePath(),
    ["-v", "error", ...(countFrames ? ["-count_frames"] : []), "-show_streams", "-show_format", "-of", "json", file],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 120000 },
  );
  if (r.status !== 0) throw new EngineError("MEDIA_PROBE_FAILED", r.error?.message ?? r.stderr);
  return JSON.parse(r.stdout);
}
export function ffmpegBuild(): string {
  const r = spawnSync(ffmpegPath(), ["-version"], { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) throw new EngineError("FFMPEG_FAILED", r.error?.message ?? r.stderr);
  return r.stdout;
}
/** Bounded diagnostics, no shell, and awaited child cleanup on abort. */
export async function runFFmpeg(args: string[], signal?: AbortSignal, cwd?: string, onProgress?: (frame: number, outTimeMs: number) => void): Promise<string> {
  if (signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Media operation cancelled");
  const proc = spawn(ffmpegPath(), onProgress ? ["-progress", "pipe:3", "-stats_period", "0.25", ...args] : args,
    { cwd, stdio: ["ignore", "ignore", "pipe", "pipe"] });
  let progress = "";
  proc.stdio[3]?.on("data", (chunk: Buffer) => {
    progress += chunk.toString();
    let end: number;
    while ((end = progress.indexOf("progress=")) >= 0) {
      const newline = progress.indexOf("\n", end);
      if (newline < 0) break;
      const block = progress.slice(0, newline);
      progress = progress.slice(newline + 1);
      onProgress?.(Number(block.match(/(?:^|\n)frame=(\d+)/)?.[1] ?? 0), Number(block.match(/out_time_us=(\d+)/)?.[1] ?? 0) / 1000);
    }
  });
  let stderr = "";
  proc.stderr!.on("data", (d) => {
    stderr = (stderr + d.toString()).slice(-65536);
  });
  const cancel = () => {
    proc.kill("SIGKILL");
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) =>
        signal?.aborted
          ? reject(new EngineError("RENDER_CANCELLED", "Media operation cancelled"))
          : code === 0
            ? resolve()
            : reject(new EngineError("FFMPEG_FAILED", stderr)),
      );
    });
    return stderr;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
