/**
 * Video encoding: raw RGBA frames are piped straight into FFmpeg's stdin (no intermediate PNGs)
 * and encoded to H.264 MP4. Optional audio tracks are delayed/mixed and muxed by FFmpeg.
 */
import { probeMedia } from "../media/process.js";
import path from "node:path";
import type { StagedSubtitles } from "../subtitles/encode.js";
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
  sourceIn?: number;
  sourceOut?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
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
  subtitles?: StagedSubtitles;
  /** Scene time of the first encoded frame; subtitle files use scene time. */
  subtitleStartSeconds?: number;
  /** Internal lossless chunk intermediate, not an encode preset. */
  lossless?: boolean;
}

export interface VideoEncoder {
  write(rgba: Buffer): Promise<void>;
  finish(): Promise<void>;
  /** Kills FFmpeg immediately and removes the partial output file. */
  abort(): Promise<void>;
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
  for (const a of audio) args.push("-i", o.subtitles ? path.resolve(a.file) : a.file);
  if (o.subtitles?.mode === "soft") {
    if (o.subtitleStartSeconds) args.push("-itsoffset", String(-o.subtitleStartSeconds));
    args.push("-i", o.subtitles.file);
  }
  if (audio.length) {
    const parts = audio.map((a, i) => {
      const ms = Math.round(Math.max(0, a.start) * 1000);
      const filters: string[] = [];
      if (a.sourceIn !== undefined || a.sourceOut !== undefined)
        filters.push(`atrim=start=${a.sourceIn ?? 0}${a.sourceOut === undefined ? "" : `:end=${a.sourceOut}`}`, "asetpts=PTS-STARTPTS");
      if (a.fadeInMs) filters.push(`afade=t=in:st=0:d=${a.fadeInMs / 1000}`);
      if (a.fadeOutMs) {
        const end = a.sourceOut ?? Number(probeMedia(a.file).format.duration);
        const duration = end - (a.sourceIn ?? 0),
          fade = Math.min(duration, a.fadeOutMs / 1000);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid audio duration for fade");
        filters.push(`afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`);
      }
      if (a.start < 0) filters.push(`atrim=start=${-a.start}`, "asetpts=PTS-STARTPTS");
      // FFmpeg 6.1 can pass invalid PTS from trimmed/delayed clips to amix.
      // Count samples after inserting silence; leave legacy whole-file graphs unchanged.
      const retimed = a.sourceIn !== undefined || a.sourceOut !== undefined || a.start < 0;
      return `[${i + 1}:a]${[...filters, "aresample=48000", `adelay=${ms}:all=1`, ...(retimed ? ["asetpts=N/SR/TB"] : []), `volume=${a.volume}`].join(",")}[a${i}]`;
    });
    const mix = audio.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${audio.length}:normalize=0:duration=longest[aout]`;
    args.push("-filter_complex", [...parts, mix].join(";"), "-map", "0:v", "-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
  }
  if (o.subtitles?.mode === "burn") {
    const offset = o.subtitleStartSeconds ?? 0;
    const filter = `subtitles=${o.subtitles.file}:fontsdir=fonts`;
    args.push("-vf", offset ? `setpts=PTS+${offset}/TB,${filter},setpts=PTS-${offset}/TB` : filter);
  }
  if (o.subtitles?.mode === "soft") {
    if (!audio.length) args.push("-map", "0:v");
    args.push("-map", `${audio.length + 1}:s:0`, "-c:s", "mov_text");
  }
  if (o.lossless) args.push("-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra");
  else
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
    );
  args.push("-t", (o.frameCount / o.fps).toFixed(6), o.subtitles ? path.resolve(o.out) : o.out);

  const proc = spawn(ffmpegPath(), args, { cwd: o.subtitles?.dir, env: o.subtitles?.env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-65536)));
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
    async abort() {
      proc.stdin.destroy();
      proc.kill("SIGKILL");
      await exited.catch(() => undefined);
      await fs.promises.rm(o.out, { force: true });
    },
  };
}
