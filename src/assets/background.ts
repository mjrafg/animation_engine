/**
 * Automatic background-colour detection from the image border.
 *
 * Method:
 *  1. Collect every pixel in the outer `borderSampleSize`-pixel band.
 *  2. Histogram them in coarse Lab bins (4 ΔE units wide); the fullest bin is the dominant mode.
 *     (A mode is robust when part of the border is covered by the subject; a mean is not.)
 *  3. Inliers = border pixels within `uniformityTolerance` ΔE of the mode.
 *     detectedColor = per-channel MEDIAN of the inliers (robust to noise/outliers).
 *  4. Diagnostics:
 *     - borderUniformity: inlier fraction over the whole band            (coverage)
 *     - sideUniformity:   inlier fraction for each side (top/right/bottom/left)
 *     - sideColorSpread:  max ΔE between the per-side median colours     (detects gradients)
 *     - noise:            90th-percentile ΔE of inliers to detectedColor (grain / compression)
 *     - confidence = min(borderUniformity, min side uniformity) · (1 - clamp(sideColorSpread / uniformityTolerance))
 *  5. The asset violates the generation contract (ok = false) if borderUniformity < minUniformity.
 *     Softer problems (subject near an edge, gradient) are reported as warnings.
 */
import { deltaE, median, rgbToLab, toHex, type Lab, type RGB } from "./color.js";
import type { RgbaImage } from "./image.js";

export interface DetectOptions {
  /** Width of the border band to sample, in pixels. Default 12. */
  borderSampleSize?: number;
  /** ΔE within which a border pixel counts as background. Default 12. */
  uniformityTolerance?: number;
  /** Minimum inlier fraction over the whole band. Default 0.9. */
  minUniformity?: number;
  /** Warn when any single side is below this inlier fraction. Default 0.97. */
  minSideUniformity?: number;
}

export interface ContractIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface BackgroundDetection {
  ok: boolean;
  backgroundDetected: boolean;
  detectedColor: RGB;
  detectedColorHex: string;
  borderUniformity: number;
  sideUniformity: { top: number; right: number; bottom: number; left: number };
  sideColorSpread: number;
  noise: number;
  confidence: number;
  sampledPixels: number;
  issues: ContractIssue[];
  options: Required<DetectOptions>;
}

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

export function detectBackground(img: RgbaImage, opts: DetectOptions = {}): BackgroundDetection {
  const o: Required<DetectOptions> = {
    borderSampleSize: opts.borderSampleSize ?? 12,
    uniformityTolerance: opts.uniformityTolerance ?? 12,
    minUniformity: opts.minUniformity ?? 0.9,
    minSideUniformity: opts.minSideUniformity ?? 0.97,
  };
  const { width: W, height: H, data } = img;
  const n = Math.max(1, Math.min(o.borderSampleSize, Math.floor(Math.min(W, H) / 2)));

  // side: 0 top, 1 right, 2 bottom, 3 left (corner pixels belong to top/bottom)
  const px: { rgb: RGB; lab: Lab; side: number }[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let side = -1;
      if (y < n) side = 0;
      else if (y >= H - n) side = 2;
      else if (x < n) side = 3;
      else if (x >= W - n) side = 1;
      else {
        x = W - n - 1; // jump to the right band
        continue;
      }
      const i = (y * W + x) * 4;
      const rgb = { r: data[i], g: data[i + 1], b: data[i + 2] };
      px.push({ rgb, lab: rgbToLab(rgb.r, rgb.g, rgb.b), side });
    }
  }

  // 1-2: coarse Lab histogram mode
  const bins = new Map<string, { count: number; L: number; a: number; b: number }>();
  for (const p of px) {
    const k = `${Math.round(p.lab.L / 4)},${Math.round(p.lab.a / 4)},${Math.round(p.lab.b / 4)}`;
    const bin = bins.get(k) ?? { count: 0, L: 0, a: 0, b: 0 };
    bin.count++;
    bin.L += p.lab.L;
    bin.a += p.lab.a;
    bin.b += p.lab.b;
    bins.set(k, bin);
  }
  let best = { count: -1, L: 0, a: 0, b: 0 };
  for (const [, bin] of [...bins.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (bin.count > best.count) best = bin;
  }
  const mode: Lab = { L: best.L / best.count, a: best.a / best.count, b: best.b / best.count };

  // 3: inliers and median colour
  const tol = o.uniformityTolerance;
  let inl = px.filter((p) => deltaE(p.lab, mode) <= tol);
  const med = (list: typeof px): RGB => ({
    r: median(list.map((p) => p.rgb.r)),
    g: median(list.map((p) => p.rgb.g)),
    b: median(list.map((p) => p.rgb.b)),
  });
  let color = med(inl);
  // one refinement pass around the median
  const colorLab = rgbToLab(Math.round(color.r), Math.round(color.g), Math.round(color.b));
  inl = px.filter((p) => deltaE(p.lab, colorLab) <= tol);
  color = med(inl);
  color = { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) };
  const finalLab = rgbToLab(color.r, color.g, color.b);

  // 4: diagnostics
  const inSide = [0, 0, 0, 0];
  const totSide = [0, 0, 0, 0];
  const sideLists: (typeof px)[] = [[], [], [], []];
  const inlierD: number[] = [];
  for (const p of px) {
    totSide[p.side]++;
    const d = deltaE(p.lab, finalLab);
    if (d <= tol) {
      inSide[p.side]++;
      sideLists[p.side].push(p);
      inlierD.push(d);
    }
  }
  const uniformity = inlierD.length / px.length;
  const sideU = inSide.map((c, i) => (totSide[i] ? c / totSide[i] : 1));
  const sideMedians = sideLists.map((l) => (l.length ? med(l) : color)).map((c) => rgbToLab(Math.round(c.r), Math.round(c.g), Math.round(c.b)));
  let spread = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) spread = Math.max(spread, deltaE(sideMedians[i], sideMedians[j]));
  inlierD.sort((a, b) => a - b);
  const noise = inlierD.length ? inlierD[Math.min(inlierD.length - 1, Math.floor(inlierD.length * 0.9))] : Infinity;
  const confidence = Math.min(uniformity, ...sideU) * (1 - Math.min(1, spread / tol));

  const issues: ContractIssue[] = [];
  const ok = uniformity >= o.minUniformity;
  if (!ok) {
    issues.push({
      severity: "error",
      code: "BORDER_NOT_UNIFORM",
      message: `Only ${(uniformity * 100).toFixed(1)}% of the ${n}px border matches the dominant colour (need ${(o.minUniformity * 100).toFixed(0)}%). The image violates the solid-background contract.`,
    });
  }
  const sideNames = ["top", "right", "bottom", "left"];
  sideU.forEach((u, i) => {
    if (u < o.minSideUniformity) {
      issues.push({
        severity: "warning",
        code: "SUBJECT_NEAR_EDGE",
        message: `${sideNames[i]} border is only ${(u * 100).toFixed(1)}% background; the subject (or its shadow) probably touches or nearly touches this edge.`,
      });
    }
  });
  if (spread > tol / 2) {
    issues.push({
      severity: "warning",
      code: "BACKGROUND_GRADIENT",
      message: `Border colour differs by ΔE ${spread.toFixed(1)} between sides; the background is not a single flat colour.`,
    });
  }

  return {
    ok,
    backgroundDetected: ok,
    detectedColor: color,
    detectedColorHex: toHex(color),
    borderUniformity: round(uniformity),
    sideUniformity: { top: round(sideU[0]), right: round(sideU[1]), bottom: round(sideU[2]), left: round(sideU[3]) },
    sideColorSpread: round(spread, 2),
    noise: round(noise, 2),
    confidence: round(Math.max(0, confidence)),
    sampledPixels: px.length,
    issues,
    options: o,
  };
}
