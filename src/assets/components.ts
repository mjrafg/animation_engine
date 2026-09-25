/**
 * Connected components of the visible alpha mask (8-connected). Used to find stray artifacts
 * left after background removal. Nothing is deleted automatically: the caller decides.
 *
 * Component ids are deterministic: 1 = largest, ties broken by first pixel in scan order.
 */
import { cloneImage, type RgbaImage } from "./image.js";

export interface Component {
  id: number;
  pixelCount: number;
  /** right/bottom exclusive */
  bounds: { left: number; top: number; right: number; bottom: number };
  centroid: { x: number; y: number };
  /** Fraction of all visible pixels. */
  share: number;
}

export interface ComponentAnalysis {
  components: Component[];
  /** Per-pixel component id (0 = transparent). */
  labels: Int32Array;
  alphaThreshold: number;
}

export function findComponents(img: RgbaImage, alphaThreshold = 0): ComponentAnalysis {
  const { width: W, height: H, data } = img;
  const N = W * H;
  const prov = new Int32Array(N);
  const queue = new Int32Array(N);
  const raw: { label: number; pixels: number; l: number; t: number; r: number; b: number; sx: number; sy: number }[] = [];
  for (let s = 0; s < N; s++) {
    if (prov[s] || data[s * 4 + 3] <= alphaThreshold) continue;
    const label = raw.length + 1;
    const c = { label, pixels: 0, l: W, t: H, r: 0, b: 0, sx: 0, sy: 0 };
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    prov[s] = label;
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % W;
      const y = (i / W) | 0;
      c.pixels++;
      c.sx += x;
      c.sy += y;
      if (x < c.l) c.l = x;
      if (y < c.t) c.t = y;
      if (x + 1 > c.r) c.r = x + 1;
      if (y + 1 > c.b) c.b = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (!prov[j] && data[j * 4 + 3] > alphaThreshold) {
            prov[j] = label;
            queue[qt++] = j;
          }
        }
      }
    }
    raw.push(c);
  }
  const total = raw.reduce((s, c) => s + c.pixels, 0) || 1;
  const sorted = [...raw].sort((a, b) => b.pixels - a.pixels || a.label - b.label);
  const remap = new Int32Array(raw.length + 1);
  sorted.forEach((c, i) => (remap[c.label] = i + 1));
  const labels = new Int32Array(N);
  for (let i = 0; i < N; i++) labels[i] = prov[i] ? remap[prov[i]] : 0;
  return {
    components: sorted.map((c, i) => ({
      id: i + 1,
      pixelCount: c.pixels,
      bounds: { left: c.l, top: c.t, right: c.r, bottom: c.b },
      centroid: { x: Math.round((c.sx / c.pixels) * 10) / 10, y: Math.round((c.sy / c.pixels) * 10) / 10 },
      share: Math.round((c.pixels / total) * 1e6) / 1e6,
    })),
    labels,
    alphaThreshold,
  };
}

/** Returns a copy of the image with the given component ids made fully transparent. */
export function removeComponents(img: RgbaImage, ids: number[], alphaThreshold = 0): { image: RgbaImage; removedPixels: number } {
  const { labels } = findComponents(img, alphaThreshold);
  const out = cloneImage(img);
  const kill = new Set(ids);
  let removedPixels = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] && kill.has(labels[i])) {
      out.data[i * 4 + 3] = 0;
      removedPixels++;
    }
  }
  return { image: out, removedPixels };
}
