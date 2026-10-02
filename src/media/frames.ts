import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { EngineError } from "../errors.js";
import type { VideoMetadata } from "../scene/schema.js";
import { readVideoSeekIndex, type VideoSeekIndex } from "./seek.js";
import { ffmpegPath } from "../render/video.js";
export interface RGBA {
  width: number;
  height: number;
  data: Buffer;
}
export interface VideoFrameSource {
  getFrame(index: number): Promise<RGBA>;
  close(): Promise<void>;
}
export interface FrameSourceOptions {
  mode?: "sequential" | "random";
  cacheBytes?: number;
  maxForwardFrames?: number;
  signal?: AbortSignal;
}
/** Seek to a preceding keyframe, then select the exact integer presentation timestamp.
 * The sequential process stays alive for nearby forward reads. */
export class FFmpegFrameSource implements VideoFrameSource {
  private cache = new Map<number, RGBA>();
  private bytes = 0;
  private decoder?: {
    proc: ChildProcessByStdio<null, Readable, Readable>;
    done: Promise<void>;
    iterator: AsyncIterator<Buffer>;
    pending: Buffer;
    next: number;
  };
  private closed = false;
  private seekIndex?: VideoSeekIndex;
  private lifetime = new AbortController();
  decodeMs = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private cancel = () => {
    this.closed = true;
    this.lifetime.abort();
    this.decoder?.proc.kill("SIGKILL");
  };
  readonly cacheBytes: number;
  constructor(
    readonly file: string,
    readonly video: VideoMetadata,
    readonly options: FrameSourceOptions = {},
  ) {
    this.cacheBytes = options.cacheBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.cacheBytes) || this.cacheBytes < 0)
      throw new EngineError("INVALID_ARGUMENT", "cacheBytes must be a nonnegative integer");
    options.signal?.addEventListener("abort", this.cancel, { once: true });
  }
  getFrame(index: number): Promise<RGBA> {
    const work = this.queue.then(() => this.read(index));
    this.queue = work.catch(() => undefined);
    return work;
  }
  private async stop() {
    const d = this.decoder;
    this.decoder = undefined;
    if (!d) return;
    d.proc.kill("SIGKILL");
    d.proc.stdout.destroy();
    await d.done.catch(() => undefined);
  }
  async close() {
    this.cancel();
    await this.stop();
    await this.queue;
    this.cache.clear();
    this.bytes = 0;
    this.seekIndex = undefined;
    this.options.signal?.removeEventListener("abort", this.cancel);
  }
  private async start(index: number) {
    await this.stop();
    if (this.closed || this.options.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Video decoder closed");
    this.seekIndex ??= await readVideoSeekIndex(this.file, this.video.frameCount, this.lifetime.signal);
    if (this.closed || this.options.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Video decoder closed");
    const seek = this.seekIndex.at(index);
    const proc = spawn(
      ffmpegPath(),
      [
        "-nostdin",
        "-v",
        "error",
        "-threads",
        "1",
        "-copyts",
        "-seek_timestamp",
        "1",
        "-ss",
        seek.timestamp,
        "-noaccurate_seek",
        "-i",
        this.file,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `select=gte(pts\\,${seek.pts})`,
        "-vsync",
        "0",
        ...(this.options.mode === "sequential" ? [] : ["-frames:v", "1"]),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-threads",
        "1",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8192);
    });
    const done = new Promise<void>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new EngineError("VIDEO_DECODE_FAILED", stderr || `Decoder exited ${code}`)),
      );
    });
    void done.catch(() => undefined);
    this.decoder = { proc, done, iterator: proc.stdout[Symbol.asyncIterator](), pending: Buffer.alloc(0), next: index };
  }
  private async pixels(): Promise<Buffer> {
    const d = this.decoder!;
    const size = this.video.width * this.video.height * 4;
    const result = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      if (this.closed || this.options.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Video decode cancelled");
      if (!d.pending.length) {
        const chunk = await d.iterator.next();
        if (chunk.done) {
          await d.done;
          throw new EngineError("VIDEO_DECODE_FAILED", "Incomplete decoded frame");
        }
        d.pending = Buffer.from(chunk.value);
      }
      const n = Math.min(size - offset, d.pending.length);
      d.pending.copy(result, offset, 0, n);
      d.pending = d.pending.subarray(n);
      offset += n;
    }
    d.next++;
    return result;
  }
  private async read(index: number): Promise<RGBA> {
    if (this.closed || this.options.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Video decoder closed");
    if (!Number.isInteger(index) || index < 0 || index >= this.video.frameCount)
      throw new EngineError("INVALID_FRAME", "Source frame outside prepared video");
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const t0 = performance.now();
    try {
      const d = this.decoder;
      if (!d || index < d.next || index - d.next > (this.options.maxForwardFrames ?? 60) || this.options.mode !== "sequential")
        await this.start(index);
      let data!: Buffer;
      do {
        data = await this.pixels();
      } while (this.decoder!.next <= index);
      const frame = { width: this.video.width, height: this.video.height, data };
      if (this.options.mode !== "sequential") {
        await this.decoder!.done;
        await this.stop();
      }
      if (data.length <= this.cacheBytes) {
        while (this.bytes + data.length > this.cacheBytes) {
          const key = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(key)!.data.length;
          this.cache.delete(key);
        }
        this.cache.set(index, frame);
        this.bytes += data.length;
      }
      return frame;
    } catch (e) {
      await this.stop();
      if (this.options.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Video decode cancelled");
      throw e;
    } finally {
      this.decodeMs += performance.now() - t0;
    }
  }
}
