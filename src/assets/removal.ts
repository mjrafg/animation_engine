/**
 * Solid-colour background removal with EDGE-CONNECTED flood fill, soft edges and despill.
 *
 *  1. ΔE (CIE76, Lab) of every pixel to the detected background colour B.
 *  2. Flood fill (4-connected) seeded from outer-ring pixels with ΔE ≤ colorTolerance.
 *     Only background that is connected to the image border is removed. Background-coloured
 *     regions enclosed by the subject (e.g. a blue stripe on a blue-screened cup, or the hole of a
 *     cup handle) are kept and reported as `holes`, so a caller can explicitly remove chosen ones.
 *  3. Soft edge / alpha estimation for the `edgeSoftness`-pixel band next to the removed region:
 *     each band pixel C is modelled as a mix C = a·F + (1-a)·B, where F is the nearby solid
 *     foreground colour that best explains C (least residual). a is the projection of C-B onto F-B.
 *     Pixels that are not a plausible B/F mix (large residual) or where F≈B keep full alpha.
 *  4. Despill (colour decontamination): partially transparent pixels are un-mixed,
 *     C' = (C - (1-a)·B) / a, which removes the background colour's contribution so no
 *     blue/green/magenta fringe remains when composited over another background.
 */
import { deltaEMap, type RGB } from "./color.js";
import { cloneImage, type RgbaImage } from "./image.js";

export interface RemovalOptions {
  /** Max ΔE from the background colour for flood fill. Default 18. */
  colorTolerance?: number;
  /** Width (px) of the edge band where partial alpha is estimated. 0 = hard binary cut. Default 3. */
  edgeSoftness?: number;
  /** Un-mix the background colour from partially transparent edge pixels. Default true. */
  despill?: boolean;
  /** RGB distance below which foreground and background are too similar to separate. Default 30. */
  minContrast?: number;
  /** Relative residual (to |F-B|) above which a band pixel is not a B/F mix (absolute floor 12). Default 0.1. */
  residualTolerance?: number;
  /**
   * Enclosed background-coloured regions to also remove: ids from a previous run's `holes`,
   * or "all" when the subject is known not to contain the key colour.
   */
  removeHoles?: number[] | "all";
  /** Enclosed regions smaller than this are not reported as holes. Default 25. */
  minHoleSize?: number;
}

export interface Bounds {
  left: number;
  top: number;
  right: number; // exclusive
  bottom: number; // exclusive
}

export interface Hole {
  id: number;
  pixelCount: number;
  bounds: Bounds;
  centroid: { x: number; y: number };
  removed: boolean;
}

export interface RemovalResult {
  image: RgbaImage;
  /** 0..255 per pixel: amount of background removed (255 = fully removed). */
  backgroundMask: Uint8Array;
  holes: Hole[];
  stats: {
    removedPixels: number;
    edgeBandPixels: number;
    partialAlphaPixels: number;
    /** Background-coloured pixels kept because they are not connected to the border. */
    preservedEnclosedPixels: number;
  };
  options: Required<RemovalOptions>;
}

export function removeBackground(src: RgbaImage, bg: RGB, opts: RemovalOptions = {}): RemovalResult {
  const o = {
    colorTolerance: opts.colorTolerance ?? 18,
    edgeSoftness: Math.max(0, Math.floor(opts.edgeSoftness ?? 3)),
    despill: opts.despill ?? true,
    minContrast: opts.minContrast ?? 30,
    residualTolerance: opts.residualTolerance ?? 0.1,
    removeHoles: opts.removeHoles ?? ([] as number[] | "all"),
    minHoleSize: opts.minHoleSize ?? 25,
  };
  const { width: W, height: H } = src;
  const N = W * H;
  const data = src.data;
  const dE = deltaEMap(data, bg);
  const tol = o.colorTolerance;
  const isBgColor = (i: number) => dE[i] <= tol && data[i * 4 + 3] > 0;

  // --- 2. edge-connected flood fill ------------------------------------------------------
  const bgMask = new Uint8Array(N); // 1 = removed background
  const queue = new Int32Array(N);
  let qh = 0;
  let qt = 0;
  const seed = (i: number) => {
    if (!bgMask[i] && (isBgColor(i) || data[i * 4 + 3] === 0)) {
      bgMask[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W;
    const y = (i / W) | 0;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (y > 0) seed(i - W);
    if (y < H - 1) seed(i + W);
  }

  // --- enclosed background-coloured regions ("holes") -------------------------------------
  const holeLabel = new Int32Array(N); // 0 = none, else provisional label
  const provisional: { label: number; pixels: number; l: number; t: number; r: number; b: number; sx: number; sy: number }[] = [];
  for (let start = 0; start < N; start++) {
    if (bgMask[start] || holeLabel[start] || !isBgColor(start)) continue;
    const label = provisional.length + 1;
    const h = { label, pixels: 0, l: W, t: H, r: 0, b: 0, sx: 0, sy: 0 };
    qh = qt = 0;
    queue[qt++] = start;
    holeLabel[start] = label;
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % W;
      const y = (i / W) | 0;
      h.pixels++;
      h.sx += x;
      h.sy += y;
      if (x < h.l) h.l = x;
      if (y < h.t) h.t = y;
      if (x + 1 > h.r) h.r = x + 1;
      if (y + 1 > h.b) h.b = y + 1;
      const visit = (j: number) => {
        if (!bgMask[j] && !holeLabel[j] && isBgColor(j)) {
          holeLabel[j] = label;
          queue[qt++] = j;
        }
      };
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (y > 0) visit(i - W);
      if (y < H - 1) visit(i + W);
    }
    provisional.push(h);
  }
  // Stable ids: largest first, ties by scan order (label).
  const reported = provisional
    .filter((h) => h.pixels >= o.minHoleSize)
    .sort((a, b) => b.pixels - a.pixels || a.label - b.label);
  const removeLabels = new Set<number>();
  const holes: Hole[] = reported.map((h, idx) => {
    const id = idx + 1;
    const removed = o.removeHoles === "all" || o.removeHoles.includes(id);
    if (removed) removeLabels.add(h.label);
    return {
      id,
      pixelCount: h.pixels,
      bounds: { left: h.l, top: h.t, right: h.r, bottom: h.b },
      centroid: { x: Math.round((h.sx / h.pixels) * 10) / 10, y: Math.round((h.sy / h.pixels) * 10) / 10 },
      removed,
    };
  });
  let preservedEnclosedPixels = 0;
  for (let i = 0; i < N; i++) {
    if (!holeLabel[i]) continue;
    if (removeLabels.has(holeLabel[i])) bgMask[i] = 1;
    else preservedEnclosedPixels++;
  }

  // --- 3. distance (chessboard) from removed region, limited ------------------------------
  const band = o.edgeSoftness;
  const R = band + 2;
  const maxD = band + R + 1;
  const dist = new Uint8Array(N).fill(255); // 0 = background
  qh = qt = 0;
  for (let i = 0; i < N; i++) {
    if (bgMask[i]) {
      dist[i] = 0;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const d = dist[i];
    if (d >= maxD) continue;
    const x = i % W;
    const y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if ((!dx && !dy) || xx < 0 || xx >= W) continue;
        const j = yy * W + xx;
        if (dist[j] > d + 1) {
          dist[j] = d + 1;
          queue[qt++] = j;
        }
      }
    }
  }

  // --- 3/4. alpha estimation + despill -----------------------------------------------------
  const out = cloneImage(src);
  const od = out.data;
  const mask = new Uint8Array(N);
  const Br = bg.r;
  const Bg = bg.g;
  const Bb = bg.b;
  // Chroma axis of the background: B minus its grey level, normalised.
  const gB = (Br + Bg + Bb) / 3;
  const uLen = Math.hypot(Br - gB, Bg - gB, Bb - gB);
  const ux = uLen ? (Br - gB) / uLen : 0;
  const uy = uLen ? (Bg - gB) / uLen : 0;
  const uz = uLen ? (Bb - gB) / uLen : 0;
  const chromaAlong = (r: number, g: number, b: number) => {
    const m = (r + g + b) / 3;
    return (r - m) * ux + (g - m) * uy + (b - m) * uz;
  };
  const sB = uLen;
  const winSize = (2 * R + 1) * (2 * R + 1);
  const candA = new Float64Array(winSize);
  const candRes = new Float64Array(winSize);
  const candLen = new Float64Array(winSize);
  const candIdx = new Int32Array(winSize);
  let removedPixels = 0;
  let edgeBandPixels = 0;
  let partialAlphaPixels = 0;

  for (let i = 0; i < N; i++) {
    if (bgMask[i]) {
      od[i * 4 + 3] = 0;
      mask[i] = 255;
      removedPixels++;
      continue;
    }
    if (band === 0 || dist[i] > band) continue;
    edgeBandPixels++;
    const x = i % W;
    const y = (i / W) | 0;
    const Cr = data[i * 4];
    const Cg = data[i * 4 + 1];
    const Cb = data[i * 4 + 2];

    // Candidate foreground references F: every non-background pixel in the window except this
    // one. Each candidate explains C as a mix C = a·F + (1-a)·B with a = proj(C-B onto F-B) and a
    // residual (distance of C from the B-F segment). Selection:
    //   1. discard candidates whose residual exceeds max(12, residualTolerance·|F-B|);
    //   2. keep those whose residual is within noise (+6) of the best residual;
    //   3. among them take the one farthest from B, i.e. the purest foreground colour, so a
    //      neighbour that is itself contaminated (same ray, closer to B) never wins.
    const CB_r = Cr - Br;
    const CB_g = Cg - Bg;
    const CB_b = Cb - Bb;
    let nCand = 0;
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(H - 1, y + R);
    const x0 = Math.max(0, x - R);
    const x1 = Math.min(W - 1, x + R);
    let minRes = Infinity;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const j = yy * W + xx;
        if (j === i || bgMask[j]) continue;
        const fr = data[j * 4] - Br;
        const fg = data[j * 4 + 1] - Bg;
        const fb = data[j * 4 + 2] - Bb;
        const fb2 = fr * fr + fg * fg + fb * fb;
        if (fb2 < o.minContrast * o.minContrast) continue;
        const fbLen = Math.sqrt(fb2);
        let a = (CB_r * fr + CB_g * fg + CB_b * fb) / fb2;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        const rr = CB_r - a * fr;
        const rg = CB_g - a * fg;
        const rb = CB_b - a * fb;
        const res = Math.sqrt(rr * rr + rg * rg + rb * rb);
        if (res > 12 && res > o.residualTolerance * fbLen) continue; // C is not a B/F mix
        candA[nCand] = a;
        candRes[nCand] = res;
        candLen[nCand] = fbLen;
        candIdx[nCand] = j;
        nCand++;
        if (res < minRes) minRes = res;
      }
    }
    let bestA = 1;
    let bestF: [number, number, number] | null = null;
    let bestLen = -1;
    for (let c = 0; c < nCand; c++) {
      if (candRes[c] <= minRes + 6 && candLen[c] > bestLen) {
        bestLen = candLen[c];
        bestA = candA[c];
        const j = candIdx[c];
        bestF = [data[j * 4], data[j * 4 + 1], data[j * 4 + 2]];
      }
    }
    if (bestF && bestA > 0.97) continue; // solid foreground (noise-level contamination)
    if (!bestF) {
      // Multi-colour edge (e.g. background + outline + fill in one pixel). Un-mix along the
      // background's chroma axis only: s(C) = (1-a)·s(B) + a·s(F), where s is the component of
      // the colour (minus its grey level) along B's chroma direction and s(F) comes from the
      // least background-tinted neighbour.
      if (sB <= 1e-6) continue; // achromatic background: no chroma axis to use
      const sC = chromaAlong(Cr, Cg, Cb);
      let sF = Infinity;
      let F: [number, number, number] | null = null;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const j = yy * W + xx;
          if (j === i || bgMask[j]) continue;
          const sj = chromaAlong(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]);
          if (sj < sF) {
            sF = sj;
            F = [data[j * 4], data[j * 4 + 1], data[j * 4 + 2]];
          }
        }
      }
      if (!F || sC <= sF || sB - sF < 1e-6) continue; // no more background tint than its neighbours
      const bgFrac = Math.min(1, (sC - sF) / (sB - sF));
      bestA = 1 - bgFrac;
      bestF = F;
    }

    const alpha = bestA;
    const srcA = data[i * 4 + 3] / 255;
    const a255 = Math.round(alpha * srcA * 255);
    od[i * 4 + 3] = a255;
    mask[i] = 255 - Math.round(alpha * 255);
    if (a255 < 255) partialAlphaPixels++;
    if (o.despill && alpha < 1) {
      const F = bestF as [number, number, number];
      if (alpha < 0.15) {
        od[i * 4] = F[0];
        od[i * 4 + 1] = F[1];
        od[i * 4 + 2] = F[2];
      } else {
        od[i * 4] = (Cr - (1 - alpha) * Br) / alpha;
        od[i * 4 + 1] = (Cg - (1 - alpha) * Bg) / alpha;
        od[i * 4 + 2] = (Cb - (1 - alpha) * Bb) / alpha;
      }
    }
  }

  return {
    image: out,
    backgroundMask: mask,
    holes,
    stats: { removedPixels, edgeBandPixels, partialAlphaPixels, preservedEnclosedPixels },
    options: o,
  };
}
