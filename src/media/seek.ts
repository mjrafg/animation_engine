import { spawn } from "node:child_process";
import { EngineError } from "../errors.js";
import { ffprobePath } from "./process.js";

export interface SeekFrame {
  pts: number;
  keyframe: boolean;
}

/** Packet PTS identify display frames exactly, including B-frame reordering and
 * time bases (e.g. Matroska) that cannot represent a frame duration exactly. */
export class VideoSeekIndex {
  constructor(
    readonly frames: SeekFrame[],
    private timeBase: [bigint, bigint],
  ) {}

  at(index: number): { timestamp: string; pts: number } {
    let key = index;
    while (key > 0 && !this.frames[key].keyframe) key--;
    // FFmpeg parses -ss in microseconds. Round upward to keep the seek at or
    // just after this keyframe, never just before it. Accurate-seek trimming is
    // disabled; the integer PTS filter below makes the final frame decision.
    const [num, den] = this.timeBase;
    const ticks = BigInt(this.frames[key].pts) * num * 1_000_000n;
    const us = ticks / den + (ticks % den > 0n ? 1n : 0n);
    const sign = us < 0n ? "-" : "";
    const magnitude = us < 0n ? -us : us;
    return {
      timestamp: `${sign}${magnitude / 1_000_000n}.${String(magnitude % 1_000_000n).padStart(6, "0")}`,
      pts: this.frames[index].pts,
    };
  }
}

/** Demux once per source; no pixel decoding. Bound diagnostics/index output and
 * await child exit on cancellation, just like the pixel decoder. */
export async function readVideoSeekIndex(file: string, frameCount: number, signal: AbortSignal): Promise<VideoSeekIndex> {
  if (signal.aborted) throw new EngineError("RENDER_CANCELLED", "Video decoder closed");
  const proc = spawn(ffprobePath(), [
    "-v", "error", "-select_streams", "v:0", "-show_packets", "-show_streams",
    "-show_entries", "packet=pts,flags:stream=time_base", "-of", "json", file,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let bytes = 0, stderr = "", tooLarge = false;
  proc.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) { tooLarge = true; proc.kill("SIGKILL"); }
    else chunks.push(chunk);
  });
  proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const cancel = () => { proc.kill("SIGKILL"); };
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 120_000);
  try {
    await new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", code => {
        if (signal.aborted) reject(new EngineError("RENDER_CANCELLED", "Video index cancelled"));
        else if (tooLarge) reject(new EngineError("VIDEO_DECODE_FAILED", "Video seek index exceeds 64 MiB"));
        else if (code !== 0) reject(new EngineError("VIDEO_DECODE_FAILED", stderr || `Video index exited ${code}`));
        else resolve();
      });
    });
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const frames: SeekFrame[] = data.packets.map((p: { pts: number; flags: string }) => ({ pts: p.pts, keyframe: p.flags.includes("K") }));
    frames.sort((a, b) => a.pts - b.pts);
    if (frames.length !== frameCount || !frames[0]?.keyframe || frames.some((f, i) => !Number.isSafeInteger(f.pts) || (i > 0 && f.pts <= frames[i - 1].pts))) {
      throw new EngineError("VIDEO_DECODE_FAILED", "Video requires one uniquely timestamped packet per prepared frame");
    }
    const timeBase = String(data.streams[0].time_base).split("/").map(BigInt);
    if (timeBase.length !== 2 || timeBase.some(n => n <= 0n)) throw new EngineError("VIDEO_DECODE_FAILED", "Invalid video time base");
    return new VideoSeekIndex(frames, timeBase as [bigint, bigint]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
