/**
 * Video encoding: raw RGBA frames are piped straight into FFmpeg's stdin (no intermediate PNGs)
 * and encoded to H.264 MP4. Optional audio tracks are delayed/mixed and muxed by FFmpeg.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function ffmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require("ffmpeg-static") as string | null;
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* fall through */
  }
  return "ffmpeg";
}

export interface AudioInput {
  file: string;
  /** Start time in seconds. */
  start: number;
  volume: number;
}

export interface EncodeOptions {
  out: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  audio?: AudioInput[];
  crf?: number;
  preset?: string;
}

export interface VideoEncoder {
  write(rgba: Buffer): Promise<void>;
  finish(): Promise<void>;
}

export function startEncoder(o: EncodeOptions): VideoEncoder {
  const audio = o.audio ?? [];
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${o.width}x${o.height}`,
    "-framerate",
    String(o.fps),
    "-i",
    "pipe:0",
  ];
  for (const a of audio) args.push("-i", a.file);
  if (audio.length) {
    const parts = audio.map((a, i) => {
      const ms = Math.round(a.start * 1000);
      return `[${i + 1}:a]aresample=48000,adelay=${ms}:all=1,volume=${a.volume}[a${i}]`;
    });
    const mix = audio.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${audio.length}:normalize=0:duration=longest[aout]`;
    args.push("-filter_complex", [...parts, mix].join(";"), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    o.preset ?? "medium",
    "-crf",
    String(o.crf ?? 18),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-t",
    (o.frameCount / o.fps).toFixed(6),
    o.out,
  );

  const proc = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}: ${stderr}`))));
  });
  // Surface early ffmpeg failure instead of hanging on a full pipe.
  let failure: unknown = null;
  exited.catch((e) => (failure = e));
  proc.stdin.on("error", () => {});

  const expected = o.width * o.height * 4;
  return {
    async write(rgba: Buffer) {
      if (failure) throw failure;
      if (rgba.length !== expected) throw new Error(`frame is ${rgba.length} bytes, expected ${expected}`);
      if (!proc.stdin.write(rgba)) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onClose = () => {
            cleanup();
            reject(failure ?? new Error(`ffmpeg closed its input: ${stderr}`));
          };
          const cleanup = () => {
            proc.stdin.off("drain", onDrain);
            proc.off("close", onClose);
          };
          proc.stdin.on("drain", onDrain);
          proc.on("close", onClose);
        });
      }
    },
    async finish() {
      proc.stdin.end();
      await exited;
    },
  };
}
