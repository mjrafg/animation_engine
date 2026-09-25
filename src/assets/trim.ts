/** trim_transparent: crop to the bounding box of visible (alpha > threshold) pixels, plus padding. */
import { createImage, type RgbaImage } from "./image.js";

export interface TrimOptions {
  /** Pixels with alpha <= threshold count as transparent. Default 4. */
  alphaThreshold?: number;
  /** Transparent padding kept around the visible bounds (clamped to the image). Default 0. */
  padding?: number;
}

export interface TrimInfo {
  originalWidth: number;
  originalHeight: number;
  trimmedWidth: number;
  trimmedHeight: number;
  /** Position of the trimmed image's top-left corner inside the original. */
  offsetX: number;
  offsetY: number;
  /** Tight bounds of visible pixels in original coordinates (right/bottom exclusive). */
  visibleBounds: { left: number; top: number; right: number; bottom: number } | null;
  alphaThreshold: number;
  padding: number;
  empty: boolean;
}

export function trimBounds(img: RgbaImage, alphaThreshold = 4) {
  const { width: W, height: H, data } = img;
  let l = W;
  let t = H;
  let r = -1;
  let b = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
    }
  }
  return r < 0 ? null : { left: l, top: t, right: r + 1, bottom: b + 1 };
}

export function trimTransparent(img: RgbaImage, opts: TrimOptions = {}): { image: RgbaImage; info: TrimInfo } {
  const alphaThreshold = opts.alphaThreshold ?? 4;
  const padding = Math.max(0, Math.floor(opts.padding ?? 0));
  const vb = trimBounds(img, alphaThreshold);
  if (!vb) {
    return {
      image: createImage(1, 1),
      info: {
        originalWidth: img.width,
        originalHeight: img.height,
        trimmedWidth: 1,
        trimmedHeight: 1,
        offsetX: 0,
        offsetY: 0,
        visibleBounds: null,
        alphaThreshold,
        padding,
        empty: true,
      },
    };
  }
  const left = Math.max(0, vb.left - padding);
  const top = Math.max(0, vb.top - padding);
  const right = Math.min(img.width, vb.right + padding);
  const bottom = Math.min(img.height, vb.bottom + padding);
  const w = right - left;
  const h = bottom - top;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const srcStart = ((top + y) * img.width + left) * 4;
    out.data.set(img.data.subarray(srcStart, srcStart + w * 4), y * w * 4);
  }
  return {
    image: out,
    info: {
      originalWidth: img.width,
      originalHeight: img.height,
      trimmedWidth: w,
      trimmedHeight: h,
      offsetX: left,
      offsetY: top,
      visibleBounds: vb,
      alphaThreshold,
      padding,
      empty: false,
    },
  };
}

/**
 * Converts a point given in ORIGINAL image pixels to normalised coordinates of the trimmed image,
 * i.e. the attachment-point convention used by scenes.
 */
export function originalPixelToTrimmedNorm(info: TrimInfo, px: number, py: number) {
  return { x: (px - info.offsetX) / info.trimmedWidth, y: (py - info.offsetY) / info.trimmedHeight };
}
