/**
 * SkiaRenderer: CPU renderer on @napi-rs/canvas (Skia). No Chromium, no WebGL.
 */
import { createCanvas, loadImage, ImageData, Path2D, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { VideoFrameSource } from "../media/frames.js";
import type { DisplayList, DrawMask, DrawSource } from "../engine/displayList.js";
import type { LoadedAsset } from "../engine/assets.js";
import type { OverlayShape, RenderedFrame, Renderer } from "./renderer.js";

export class SkiaRenderer implements Renderer {
  readonly name = "skia";
  private videos: ReadonlyMap<string, VideoFrameSource> = new Map();
  private videoCanvas: Canvas | null = null;
  setVideoSources(sources: ReadonlyMap<string, VideoFrameSource>) {
    this.videos = sources;
  }
  private images = new Map<string, Image>();
  private loadedBytes = new Map<string, Buffer>();
  private canvas: Canvas | null = null;
  private scratch: { layer: Canvas; mask: Canvas } | null = null;
  private outsideStrokeCanvas: Canvas | null = null;

  async loadAssets(assets: LoadedAsset[]): Promise<void> {
    const next = new Map<string, Image>();
    for (const a of assets) {
      if (a.kind === "video") continue;
      const existing = this.images.get(a.id);
      if (existing && this.loadedBytes.get(a.id) === a.bytes) {
        next.set(a.id, existing);
        continue;
      }
      next.set(a.id, await loadImage(a.bytes));
      this.loadedBytes.set(a.id, a.bytes);
    }
    this.images = next;
  }

  private getCanvas(w: number, h: number): Canvas {
    if (!this.canvas || this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas = createCanvas(w, h);
      this.scratch = null;
    }
    return this.canvas;
  }

  private getScratch(w: number, h: number) {
    if (!this.scratch) this.scratch = { layer: createCanvas(w, h), mask: createCanvas(w, h) };
    return this.scratch;
  }

  private drawOutsideStroke(ctx: SKRSContext2D, p: Path2D, color: string, width: number) {
    const { width: W, height: H } = ctx.canvas;
    if (!this.outsideStrokeCanvas || this.outsideStrokeCanvas.width !== W || this.outsideStrokeCanvas.height !== H) {
      this.outsideStrokeCanvas = createCanvas(W, H);
    }
    const stroke = this.outsideStrokeCanvas.getContext("2d");
    stroke.setTransform(1, 0, 0, 1, 0, 0);
    stroke.clearRect(0, 0, W, H);
    stroke.globalCompositeOperation = "source-over";
    const m = ctx.getTransform();
    stroke.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    stroke.strokeStyle = color;
    stroke.lineWidth = width * 2;
    stroke.lineJoin = ctx.lineJoin;
    stroke.lineCap = ctx.lineCap;
    stroke.miterLimit = ctx.miterLimit;
    stroke.stroke(p);
    // Erase only the isolated stroke's interior, never the shape fill or prior layers.
    // Avoid the binding's unreliable compound-path even-odd clipping.
    stroke.globalCompositeOperation = "destination-out";
    stroke.fillStyle = "#ffffff";
    stroke.fill(p);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Pixels already include transformed vector antialiasing. A high-quality
    // 1:1 resample in this binding adds a halo and bleeds into the shape fill.
    ctx.imageSmoothingEnabled = false;
    // Apply opacity, feather and shadow once, to the finished outside geometry.
    ctx.drawImage(this.outsideStrokeCanvas, 0, 0);
    ctx.restore();
  }

  private async drawSource(ctx: SKRSContext2D, src: DrawSource | { kind: "rect" }, w: number, h: number) {
    if (src.kind === "shape") {
      const s = src.shape,
        p = new Path2D(s.type === "path" ? s.d : undefined);
      if (s.type === "rect") p.roundRect(0, 0, w, h, Math.min(s.cornerRadius ?? 0, w / 2, h / 2));
      if (s.type === "ellipse") p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.save();
      if (s.feather) ctx.filter = `blur(${s.feather}px)`;
      if (s.shadow) {
        ctx.shadowColor = s.shadow.color;
        ctx.shadowBlur = s.shadow.blur;
        ctx.shadowOffsetX = s.shadow.x;
        ctx.shadowOffsetY = s.shadow.y;
      }
      if (s.fill) {
        ctx.fillStyle = s.fill;
        ctx.fill(p);
      }
      if (s.stroke && (s.strokeWidth ?? 1) > 0) {
        ctx.save();
        const align = s.strokeAlign ?? "center";
        if (align === "outside") {
          this.drawOutsideStroke(ctx, p, s.stroke, s.strokeWidth ?? 1);
        } else {
          if (align === "inside") ctx.clip(p);
          ctx.strokeStyle = s.stroke;
          ctx.lineWidth = (s.strokeWidth ?? 1) * (align === "center" ? 1 : 2);
          ctx.stroke(p);
        }
        ctx.restore();
      }
      ctx.restore();
    } else if (src.kind === "video") {
      const source = this.videos.get(src.assetId);
      if (!source) throw new Error(`Video source ${src.assetId} is not loaded`);
      const frame = await source.getFrame(src.sourceFrame);
      if (!this.videoCanvas || this.videoCanvas.width !== frame.width || this.videoCanvas.height !== frame.height)
        this.videoCanvas = createCanvas(frame.width, frame.height);
      this.videoCanvas
        .getContext("2d")
        .putImageData(
          new ImageData(new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), frame.width, frame.height),
          0,
          0,
        );
      ctx.drawImage(this.videoCanvas, 0, 0, w, h);
    } else if (src.kind === "image") {
      const img = this.images.get(src.assetId);
      if (!img) throw new Error(`Asset "${src.assetId}" is not loaded in the renderer`);
      ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, w, h);
    } else {
      ctx.fillStyle = src.kind === "fill" ? src.color : "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
  }

  private static prepare(ctx: SKRSContext2D) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  async render(list: DisplayList, overlay?: OverlayShape[]): Promise<RenderedFrame> {
    const { width: W, height: H } = list;
    const canvas = this.getCanvas(W, H);
    const ctx = canvas.getContext("2d");
    SkiaRenderer.prepare(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = list.background;
    ctx.fillRect(0, 0, W, H);

    for (const cmd of list.commands) {
      const m = cmd.matrix;
      if (!cmd.mask) {
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.globalAlpha = cmd.opacity;
        await this.drawSource(ctx, cmd.source, cmd.width, cmd.height);
        continue;
      }
      // Masked layer: draw into a scratch layer, multiply by a full-canvas mask, composite.
      const scratch = this.getScratch(W, H);
      const lctx = scratch.layer.getContext("2d");
      SkiaRenderer.prepare(lctx);
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = "source-over";
      lctx.globalAlpha = 1;
      lctx.clearRect(0, 0, W, H);
      lctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      await this.drawSource(lctx, cmd.source, cmd.width, cmd.height);

      await this.drawMask(scratch.mask, cmd.mask, W, H);
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = cmd.mask.invert ? "destination-out" : "destination-in";
      lctx.drawImage(scratch.mask, 0, 0);
      lctx.globalCompositeOperation = "source-over";

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = cmd.opacity;
      ctx.drawImage(scratch.layer, 0, 0);
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    if (overlay?.length) drawOverlay(ctx, overlay);

    return {
      width: W,
      height: H,
      rgba: () => Buffer.from(ctx.getImageData(0, 0, W, H).data.buffer),
      png: async () => canvas.encode("png"),
    };
  }

  private async drawMask(maskCanvas: Canvas, mask: DrawMask, W: number, H: number) {
    const mctx = maskCanvas.getContext("2d");
    SkiaRenderer.prepare(mctx);
    mctx.setTransform(1, 0, 0, 1, 0, 0);
    mctx.globalCompositeOperation = "source-over";
    mctx.globalAlpha = 1;
    mctx.clearRect(0, 0, W, H);
    if (mask.width <= 0 || mask.height <= 0) return;
    const m = mask.matrix;
    mctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    mctx.globalAlpha = mask.opacity;
    await this.drawSource(mctx, mask.source, mask.width, mask.height);
    mctx.globalAlpha = 1;
    mctx.setTransform(1, 0, 0, 1, 0, 0);
  }
}

function drawOverlay(ctx: SKRSContext2D, shapes: OverlayShape[]) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  for (const s of shapes) {
    switch (s.kind) {
      case "polygon": {
        ctx.beginPath();
        s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.setLineDash(s.dash ?? []);
        ctx.strokeStyle = s.stroke;
        ctx.lineWidth = s.lineWidth;
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      }
      case "circle": {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
        if (s.fill) {
          ctx.fillStyle = s.fill;
          ctx.fill();
        }
        if (s.stroke) {
          ctx.strokeStyle = s.stroke;
          ctx.lineWidth = s.lineWidth ?? 1;
          ctx.stroke();
        }
        break;
      }
      case "cross": {
        ctx.beginPath();
        ctx.moveTo(s.x - s.size, s.y);
        ctx.lineTo(s.x + s.size, s.y);
        ctx.moveTo(s.x, s.y - s.size);
        ctx.lineTo(s.x, s.y + s.size);
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.lineWidth;
        ctx.stroke();
        break;
      }
      case "text": {
        ctx.font = `${s.size}px "DejaVu Sans Mono", "Liberation Mono", monospace`;
        ctx.textBaseline = "top";
        if (s.background) {
          const w = ctx.measureText(s.text).width;
          ctx.fillStyle = s.background;
          ctx.fillRect(s.x - 2, s.y - 1, w + 4, s.size + 3);
        }
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, s.x, s.y);
        break;
      }
    }
  }
  ctx.restore();
}
