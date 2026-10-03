/**
 * AnimationEngine: the deterministic pipeline
 *
 *   scene JSON --validate--> Scene --evaluate(frame)--> FrameState --resolve--> ResolvedFrame
 *     --buildDisplayList--> DisplayList --Renderer--> RGBA --FFmpeg--> MP4
 *
 * Output depends only on (scene, asset files, frame number, renderer build). No clocks, no RNG.
 */
import { stageSubtitles, mediaCapabilities, type SubtitleOptions } from "../subtitles/encode.js";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { renderChunks } from "../render/chunks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "../media/process.js";
import { FFmpegFrameSource } from "../media/frames.js";
import { AssetCatalog } from "../engine/assets.js";
import { EngineError } from "../errors.js";
import { buildDebugOverlay, type DebugOptions } from "../engine/debugOverlay.js";
import { buildDisplayList, type DisplayList } from "../engine/displayList.js";
import { measureResolvedLayout, type FrameLayout } from "../engine/layout.js";
import { resolveFrame, type ResolvedFrame } from "../engine/transform.js";
import type { RenderedFrame, Renderer } from "../render/renderer.js";
import { SkiaRenderer } from "../render/skia.js";
import { startEncoder } from "../render/video.js";
import type { Scene } from "../scene/schema.js";
import { SceneValidationError, resolveScenePath, validateScene, type ValidationResult } from "../scene/validate.js";
import { evaluateScene, type FrameState } from "../timeline/evaluate.js";

export interface RenderVideoOptions {
  subtitles?: SubtitleOptions;
  chunks?: number;
  videoCacheBytes?: number;
  startFrame?: number;
  /** Exclusive. Defaults to scene.duration. */
  endFrame?: number;
  crf?: number;
  preset?: string;
  /** Lossless RGB master for later mux/subtitle variants; use a Matroska output. */
  intermediate?: "lossless-rgb";
  /** Include scene audio tracks (default true). */
  audio?: boolean;
  onProgress?: (frame: number, total: number) => void;
  /** Aborting stops rendering, kills FFmpeg, deletes the partial file and throws RENDER_CANCELLED. */
  signal?: AbortSignal;
}

export class AnimationEngine {
  private videoMode: "random" | "sequential" = "random";
  private videoSources = new Map<string, FFmpegFrameSource>();
  private catalog = new AssetCatalog();
  private _scene: Scene | null = null;
  private renderer: Renderer;
  private rendererAssetsVersion = -1;
  private assetsVersion = 0;

  /**
   * @param document raw scene JSON (as authored)
   * @param baseDir directory for resolving relative asset/audio paths
   */
  constructor(
    private document: unknown,
    readonly baseDir: string,
    renderer?: Renderer,
  ) {
    this.renderer = renderer ?? new SkiaRenderer();
  }

  static async fromFile(file: string, renderer?: Renderer): Promise<AnimationEngine> {
    const text = await fs.readFile(file, "utf8");
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch (e) {
      throw new SceneValidationError([{ severity: "error", code: "INVALID_JSON", path: [], message: (e as Error).message }]);
    }
    return new AnimationEngine(doc, path.dirname(path.resolve(file)), renderer);
  }

  /** Replace the scene document (e.g. after an agent edit). Call `prepare()` again. */
  setDocument(doc: unknown) {
    this.document = doc;
    this._scene = null;
  }

  validate(): ValidationResult {
    return validateScene(this.document, { baseDir: this.baseDir });
  }

  /** Validates and loads assets. Throws SceneValidationError with machine-readable issues. */
  async prepare(): Promise<Scene> {
    await this.closeVideoSources();
    const v = this.validate();
    if (!v.ok || !v.scene) throw new SceneValidationError(v.errors);
    await this.catalog.load(v.scene, this.baseDir);
    this._scene = v.scene;
    this.assetsVersion++;
    return v.scene;
  }

  get scene(): Scene {
    if (!this._scene) throw new Error("call prepare() first");
    return this._scene;
  }

  private checkFrame(frame: number) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.scene.duration) {
      throw new EngineError("INVALID_FRAME", `frame must be an integer in [0, ${this.scene.duration - 1}], got ${frame}`, {
        frame,
        duration: this.scene.duration,
      });
    }
  }

  evaluate(frame: number): FrameState {
    return evaluateScene(this.scene, frame, this.catalog.size);
  }

  resolve(frame: number): ResolvedFrame {
    return resolveFrame(this.evaluate(frame), this.scene.canvas);
  }

  displayList(frame: number): DisplayList {
    return buildDisplayList(this.scene, this.resolve(frame));
  }

  /** Geometry of every layer at `frame` (optionally only the listed layer ids, in document order). */
  measureLayout(frame: number, opts: { layers?: string[] } = {}): FrameLayout {
    this.checkFrame(frame);
    const layout = measureResolvedLayout(this.resolve(frame));
    if (opts.layers) {
      const want = new Set(opts.layers);
      const unknown = opts.layers.filter((id) => !layout.layers.some((l) => l.id === id));
      if (unknown.length) throw new EngineError("LAYER_NOT_FOUND", `Unknown layer(s): ${unknown.join(", ")}`, { layers: unknown });
      layout.layers = layout.layers.filter((l) => want.has(l.id));
    }
    return layout;
  }

  async closeVideoSources() {
    await Promise.all([...this.videoSources.values()].map((source) => source.close()));
    this.videoSources.clear();
  }

  private verifyVideoBytes() {
    for (const a of this.catalog.all())
      if (a.video) {
        let actual: string;
        try {
          actual = hashFile(a.file);
        } catch {
          throw new SceneValidationError([
            { severity: "error", code: "MISSING_VIDEO_FILE", path: ["assets", a.id, "src"], message: "Prepared video file is unavailable" },
          ]);
        }
        if (actual !== a.video.sha256)
          throw new SceneValidationError([
            {
              severity: "error",
              code: "VIDEO_HASH_MISMATCH",
              path: ["assets", a.id, "video", "sha256"],
              message: "Prepared video bytes have changed",
            },
          ]);
      }
  }

  async configureVideoSources(mode: "sequential" | "random", signal?: AbortSignal, cacheBytes?: number) {
    await this.closeVideoSources();
    this.verifyVideoBytes();
    this.videoMode = mode;
    const videos = this.catalog.all().filter((a) => a.video);
    if (videos.length && !this.renderer.setVideoSources)
      throw new EngineError("UNSUPPORTED_RENDERER", "Renderer has no video frame source support");
    for (const a of videos) this.videoSources.set(a.id, new FFmpegFrameSource(a.file, a.video!, { mode, signal, cacheBytes }));
    this.renderer.setVideoSources?.(this.videoSources);
  }

  private async ensureRendererAssets() {
    if (this.rendererAssetsVersion !== this.assetsVersion) {
      await this.renderer.loadAssets(this.catalog.all());
      this.rendererAssetsVersion = this.assetsVersion;
    }
  }

  async renderFrame(frame: number): Promise<RenderedFrame> {
    this.checkFrame(frame);
    await this.ensureRendererAssets();
    if (!this.videoSources.size) await this.configureVideoSources("random");
    else if (this.videoMode === "random") this.verifyVideoBytes();
    return this.renderer.render(this.displayList(frame));
  }

  async renderPreview(frame: number, outPng: string): Promise<string> {
    const f = await this.renderFrame(frame);
    await fs.mkdir(path.dirname(outPng), { recursive: true });
    await fs.writeFile(outPng, await f.png());
    return outPng;
  }

  async renderDebugPreview(frame: number, outPng: string, opts?: DebugOptions): Promise<string> {
    this.checkFrame(frame);
    await this.ensureRendererAssets();
    if (!this.videoSources.size) await this.configureVideoSources("random");
    else if (this.videoMode === "random") this.verifyVideoBytes();
    const resolved = this.resolve(frame);
    const overlay = buildDebugOverlay(measureResolvedLayout(resolved), opts);
    const f = await this.renderer.render(buildDisplayList(this.scene, resolved), overlay);
    await fs.mkdir(path.dirname(outPng), { recursive: true });
    await fs.writeFile(outPng, await f.png());
    return outPng;
  }

  async renderVideo(
    out: string,
    o: RenderVideoOptions = {},
  ): Promise<{ file: string; frames: number; seconds: number; warnings?: unknown[]; timings?: Record<string, number> }> {
    const t0 = performance.now();
    const timings = { drawMs: 0, decodeMs: 0, encodeWriteMs: 0, encodeFinishMs: 0, chunksMs: 0, totalMs: 0, reusedFrames: 0 };
    const scene = this.scene;
    const chunks = o.chunks ?? 1;
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 16)
      throw new EngineError("INVALID_ARGUMENT", "chunks must be an integer in [1,16]");
    const start = o.startFrame ?? 0;
    const end = o.endFrame ?? scene.duration;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= scene.duration && end > start)) {
      throw new EngineError("INVALID_FRAME", `invalid frame range [${start}, ${end}) for duration ${scene.duration}`, {
        startFrame: start,
        endFrame: end,
        duration: scene.duration,
      });
    }
    await this.ensureRendererAssets();
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    const fps = scene.canvas.fps;
    if (chunks > 1 && o.intermediate === "lossless-rgb" && o.audio === false && !o.subtitles) {
      const directory = await fs.mkdtemp(path.join(path.dirname(path.resolve(out)), ".visual-chunks-"));
      const chunkStart = performance.now();
      try {
        const joined = await renderChunks(this.document, this.baseDir, directory, start, end,
          Math.min(chunks, end - start), o.signal, o.onProgress, o.videoCacheBytes, true, (metrics) => {
            for (const name of ["drawMs", "decodeMs", "encodeWriteMs", "encodeFinishMs", "reusedFrames"] as const) timings[name] += metrics[name] ?? 0;
          });
        o.signal?.throwIfAborted();
        // Each chunk is lossless RGB. Concatenation needs no pixel decode or
        // second encoder pass; audio/subtitles are deliberately absent here.
        await fs.copyFile(joined, out);
        timings.chunksMs = performance.now() - chunkStart;
        timings.totalMs = performance.now() - t0;
        return { file: out, frames: end - start, seconds: (end - start) / scene.canvas.fps, timings };
      } catch (error) {
        await fs.rm(out, { force: true });
        throw error;
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
        await this.closeVideoSources();
      }
    }
    const audio =
      o.audio === false
        ? []
        : scene.audio.map((a) => ({
            file: resolveScenePath(this.baseDir, a.src),
            start: (a.startFrame - start) / fps + (a.startOffsetMs ?? 0) / 1000,
            sourceIn: a.sourceIn,
            sourceOut: a.sourceOut,
            fadeInMs: a.fadeInMs,
            fadeOutMs: a.fadeOutMs,
            volume: a.volume,
          }));
    const subtitles = o.subtitles ? await stageSubtitles(o.subtitles, this.baseDir) : undefined;
    let enc: ReturnType<typeof startEncoder> | undefined;
    let chunkDir: string | undefined, chunkSource: FFmpegFrameSource | undefined;
    const cancel = () => {
      void enc?.abort();
    };
    o.signal?.addEventListener("abort", cancel, { once: true });
    const warnings: { severity: "warning"; code: string; path: string[]; message: string }[] = [];
    try {
      if (o.subtitles?.mode === "burn") {
        const caps = await mediaCapabilities(path.resolve(this.baseDir, o.subtitles.fontsDir!));
        if (!caps.subtitles.complexShaping)
          warnings.push({
            severity: "warning",
            code: "SUBTITLE_SHAPING_UNAVAILABLE",
            path: ["subtitles"],
            message: caps.subtitles.reason ?? "Complex shaping unavailable",
          });
      }
      enc = startEncoder({
        subtitles,
        subtitleStartSeconds: start / fps,
        out,
        width: scene.canvas.width,
        height: scene.canvas.height,
        fps,
        frameCount: end - start,
        audio,
        crf: o.crf,
        preset: o.preset,
        lossless: o.intermediate === "lossless-rgb" ? "rgb" : false,
      });

      if (chunks > 1) {
        chunkDir = await fs.mkdtemp(path.join(os.tmpdir(), "ae-chunks-"));
        const chunkStart = performance.now();
        const joined = await renderChunks(
          this.document,
          this.baseDir,
          chunkDir,
          start,
          end,
          Math.min(chunks, end - start),
          o.signal,
          undefined,
          o.videoCacheBytes,
        );
        timings.chunksMs = performance.now() - chunkStart;
        chunkSource = new FFmpegFrameSource(
          joined,
          { ...scene.canvas, frameCount: end - start, duration: (end - start) / fps, preparedBy: "prepare_video_asset@1", sha256: "" },
          { mode: "sequential", cacheBytes: 0, signal: o.signal },
        );
      }
      await this.configureVideoSources("sequential", o.signal, o.videoCacheBytes);
      let previousKey: string | undefined;
      let previousPixels: Buffer | undefined;
      for (let f = start; f < end; f++) {
        if (o.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Render cancelled", { frame: f });
        const drawStart = performance.now();
        let rgba: Buffer;
        if (chunkSource) rgba = (await chunkSource.getFrame(f - start)).data;
        else {
          const list = this.displayList(f);
          // The built-in renderer consumes commands, not the bookkeeping frame
          // number. Equality is exact, including video source frame and masks.
          // Custom renderers may use list.frame, so their calls are never elided.
          const key = this.renderer instanceof SkiaRenderer ? JSON.stringify({ ...list, frame: 0 }) : undefined;
          if (key !== undefined && key === previousKey && previousPixels) {
            rgba = previousPixels;
            timings.reusedFrames++;
          } else {
            rgba = (await this.renderer.render(list)).rgba();
            previousKey = key;
            previousPixels = rgba;
          }
        }
        timings.drawMs += performance.now() - drawStart;
        const encodeStart = performance.now();
        await enc.write(rgba);
        timings.encodeWriteMs += performance.now() - encodeStart;
        o.onProgress?.(f - start + 1, end - start);
      }
      const finishStart = performance.now();
      await enc.finish();
      timings.encodeFinishMs = performance.now() - finishStart;
    } catch (e) {
      await enc?.abort();
      if (o.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Render cancelled");
      if (e instanceof EngineError || e instanceof SceneValidationError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new EngineError(/ffmpeg/i.test(msg) ? "FFMPEG_FAILED" : "RENDER_FAILED", msg);
    } finally {
      o.signal?.removeEventListener("abort", cancel);
      timings.decodeMs = [...this.videoSources.values()].reduce((n, s) => n + s.decodeMs, 0) + (chunkSource?.decodeMs ?? 0);
      timings.drawMs = Math.max(0, timings.drawMs - timings.decodeMs);
      await this.closeVideoSources();
      await chunkSource?.close();
      await subtitles?.cleanup();
      if (chunkDir) await fs.rm(chunkDir, { recursive: true, force: true });
    }
    timings.totalMs = performance.now() - t0;
    return { file: out, frames: end - start, seconds: (end - start) / fps, timings, ...(warnings.length ? { warnings } : {}) };
  }
}
