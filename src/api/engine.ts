/**
 * AnimationEngine: the deterministic pipeline
 *
 *   scene JSON --validate--> Scene --evaluate(frame)--> FrameState --resolve--> ResolvedFrame
 *     --buildDisplayList--> DisplayList --Renderer--> RGBA --FFmpeg--> MP4
 *
 * Output depends only on (scene, asset files, frame number, renderer build). No clocks, no RNG.
 */
import fs from "node:fs/promises";
import path from "node:path";
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
  startFrame?: number;
  /** Exclusive. Defaults to scene.duration. */
  endFrame?: number;
  crf?: number;
  preset?: string;
  /** Include scene audio tracks (default true). */
  audio?: boolean;
  onProgress?: (frame: number, total: number) => void;
  /** Aborting stops rendering, kills FFmpeg, deletes the partial file and throws RENDER_CANCELLED. */
  signal?: AbortSignal;
}

export class AnimationEngine {
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
      throw new SceneValidationError([
        { severity: "error", code: "INVALID_JSON", path: [], message: (e as Error).message },
      ]);
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

  private async ensureRendererAssets() {
    if (this.rendererAssetsVersion !== this.assetsVersion) {
      await this.renderer.loadAssets(this.catalog.all());
      this.rendererAssetsVersion = this.assetsVersion;
    }
  }

  async renderFrame(frame: number): Promise<RenderedFrame> {
    this.checkFrame(frame);
    await this.ensureRendererAssets();
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
    const resolved = this.resolve(frame);
    const overlay = buildDebugOverlay(measureResolvedLayout(resolved), opts);
    const f = await this.renderer.render(buildDisplayList(this.scene, resolved), overlay);
    await fs.mkdir(path.dirname(outPng), { recursive: true });
    await fs.writeFile(outPng, await f.png());
    return outPng;
  }

  async renderVideo(out: string, o: RenderVideoOptions = {}): Promise<{ file: string; frames: number; seconds: number }> {
    const scene = this.scene;
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
    const audio =
      o.audio === false
        ? []
        : scene.audio.map((a) => ({
            file: resolveScenePath(this.baseDir, a.src),
            start: (a.startFrame - start) / fps,
            volume: a.volume,
          })).filter((a) => a.start >= 0);
    const enc = startEncoder({
      out,
      width: scene.canvas.width,
      height: scene.canvas.height,
      fps,
      frameCount: end - start,
      audio,
      crf: o.crf,
      preset: o.preset,
    });
    try {
      for (let f = start; f < end; f++) {
        if (o.signal?.aborted) throw new EngineError("RENDER_CANCELLED", "Render cancelled", { frame: f });
        const frame = await this.renderer.render(this.displayList(f));
        await enc.write(frame.rgba());
        o.onProgress?.(f - start + 1, end - start);
      }
      await enc.finish();
    } catch (e) {
      await enc.abort();
      if (e instanceof EngineError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new EngineError(/ffmpeg/i.test(msg) ? "FFMPEG_FAILED" : "RENDER_FAILED", msg);
    }
    return { file: out, frames: end - start, seconds: (end - start) / fps };
  }
}
