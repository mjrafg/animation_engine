/**
 * Non-destructive asset processing pipeline.
 *
 *   Path A (native transparency):  original -> validate alpha -> [remove components] -> trim
 *   Path B (solid colour key):     original -> detect border colour -> validate uniformity
 *                                  -> edge-connected flood fill -> soft alpha + despill
 *                                  -> [remove components] -> trim
 *
 * Output directory layout (the source file is never modified):
 *   original.<ext>              byte-identical copy of the source
 *   background-mask.png         0..255 amount of background removed per pixel (white = removed)
 *   untrimmed-transparent.png   full-size result
 *   processed-transparent.png   trimmed result (use this in scenes)
 *   asset-metadata.json         diagnostics, trim offsets, components, attachment points
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectBackground, type BackgroundDetection, type ContractIssue, type DetectOptions } from "./background.js";
import { findComponents, removeComponents, type Component } from "./components.js";
import { readRgba, writeMaskPng, writePng, type RgbaImage } from "./image.js";
import { removeBackground, type Hole, type RemovalOptions } from "./removal.js";
import { originalPixelToTrimmedNorm, trimTransparent, type TrimInfo, type TrimOptions } from "./trim.js";

export type ProcessMode = "auto" | "transparent" | "color-key";

export interface ProcessOptions {
  /** auto (default): native alpha if the border is mostly transparent, else colour key. */
  mode?: ProcessMode;
  detect?: DetectOptions;
  removal?: RemovalOptions;
  trim?: TrimOptions;
  /** Component ids (from a previous run's metadata) to delete before trimming. */
  removeComponents?: number[];
  /** Components are computed on alpha > this. Default 8. */
  componentAlphaThreshold?: number;
  /** Named points in ORIGINAL image pixels; converted to normalised trimmed coordinates. */
  attachmentPointsPx?: Record<string, { x: number; y: number }>;
  /** Process even if the background violates the generation contract. Default false. */
  force?: boolean;
}

export interface AlphaDiagnostics {
  hasAlphaChannel: boolean;
  borderTransparentFraction: number;
  transparentFraction: number;
  partialFraction: number;
  opaqueFraction: number;
}

export interface AssetMetadata {
  ok: boolean;
  /** Source image path, relative to the output directory. */
  source: string;
  sourceSha256: string;
  path: "native-alpha" | "color-key";
  files: Record<string, string>;
  alpha: AlphaDiagnostics;
  detection?: BackgroundDetection;
  removal?: { holes: Hole[]; stats: Record<string, number>; options: unknown };
  components: Component[];
  removedComponents: number[];
  trim?: TrimInfo;
  size?: { width: number; height: number };
  attachmentPoints?: Record<string, { x: number; y: number }>;
  issues: ContractIssue[];
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

export function analyzeAlpha(img: RgbaImage, hasAlphaChannel: boolean, band = 4): AlphaDiagnostics {
  const { width: W, height: H, data } = img;
  let bt = 0;
  let bn = 0;
  let t = 0;
  let p = 0;
  let o = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = data[(y * W + x) * 4 + 3];
      if (a <= 4) t++;
      else if (a >= 251) o++;
      else p++;
      if (x < band || y < band || x >= W - band || y >= H - band) {
        bn++;
        if (a <= 4) bt++;
      }
    }
  }
  const n = W * H;
  return {
    hasAlphaChannel,
    borderTransparentFraction: r4(bt / bn),
    transparentFraction: r4(t / n),
    partialFraction: r4(p / n),
    opaqueFraction: r4(o / n),
  };
}

export async function processAsset(input: string, outDir: string, opts: ProcessOptions = {}): Promise<AssetMetadata> {
  const bytes = await fs.readFile(input);
  const { image, hasAlpha } = await readRgba(bytes);
  await fs.mkdir(outDir, { recursive: true });
  const ext = path.extname(input) || ".png";
  const files: Record<string, string> = { original: "original" + ext.toLowerCase() };
  if (path.resolve(input) !== path.resolve(outDir, files.original)) await fs.writeFile(path.join(outDir, files.original), bytes);

  const alpha = analyzeAlpha(image, hasAlpha);
  const mode = opts.mode ?? "auto";
  const useAlpha = mode === "transparent" || (mode === "auto" && hasAlpha && alpha.borderTransparentFraction >= 0.5);
  const issues: ContractIssue[] = [];
  const meta: AssetMetadata = {
    ok: true,
    /** relative to the output directory, so metadata stays valid when the folder moves */
    source: path.relative(outDir, path.resolve(input)),
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    path: useAlpha ? "native-alpha" : "color-key",
    files,
    alpha,
    components: [],
    removedComponents: [],
    issues,
  };

  let keyed: RgbaImage;
  let mask: Uint8Array;
  if (useAlpha) {
    if (alpha.transparentFraction === 0) issues.push({ severity: "warning", code: "NO_TRANSPARENCY", message: "Image has no transparent pixels" });
    if (alpha.borderTransparentFraction < 0.98) {
      issues.push({ severity: "warning", code: "SUBJECT_NEAR_EDGE", message: "Visible pixels touch the image border; the subject may be cropped" });
    }
    if (alpha.partialFraction === 0 && alpha.transparentFraction > 0) {
      issues.push({ severity: "warning", code: "HARD_ALPHA_EDGES", message: "Alpha has no partial values; edges may look jagged" });
    }
    keyed = image;
    mask = new Uint8Array(image.width * image.height);
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - image.data[i * 4 + 3];
  } else {
    const detection = detectBackground(image, opts.detect);
    meta.detection = detection;
    issues.push(...detection.issues);
    if (!detection.ok && !opts.force) {
      meta.ok = false;
      await fs.writeFile(path.join(outDir, "asset-metadata.json"), JSON.stringify(meta, null, 2));
      files.metadata = "asset-metadata.json";
      return meta;
    }
    const removal = removeBackground(image, detection.detectedColor, opts.removal);
    meta.removal = { holes: removal.holes, stats: removal.stats, options: removal.options };
    if (removal.holes.some((h) => !h.removed)) {
      issues.push({
        severity: "warning",
        code: "ENCLOSED_BACKGROUND_COLOR",
        message: `${removal.holes.filter((h) => !h.removed).length} enclosed background-coloured region(s) were kept (not connected to the border). Pass removal.removeHoles with their ids if they are real holes.`,
      });
    }
    keyed = removal.image;
    mask = removal.backgroundMask;
  }

  // Component ids always refer to the keyed image BEFORE any component removal, so the ids an
  // agent reads from one run's metadata stay valid when it re-runs with removeComponents.
  const compThreshold = opts.componentAlphaThreshold ?? 8;
  meta.components = findComponents(keyed, compThreshold).components;
  if (opts.removeComponents?.length) {
    keyed = removeComponents(keyed, opts.removeComponents, compThreshold).image;
    meta.removedComponents = [...opts.removeComponents];
    for (let i = 0; i < mask.length; i++) mask[i] = 255 - keyed.data[i * 4 + 3];
  }
  const remaining = meta.components.length - meta.removedComponents.filter((id) => id <= meta.components.length).length;
  if (remaining > 1) {
    issues.push({
      severity: "warning",
      code: "MULTIPLE_COMPONENTS",
      message: `${remaining} disconnected visible components remain. Inspect them and pass removeComponents with the ids of artifacts, if any.`,
    });
  }

  const { image: trimmed, info } = trimTransparent(keyed, opts.trim);
  meta.trim = info;
  meta.size = { width: info.trimmedWidth, height: info.trimmedHeight };
  if (info.empty) {
    meta.ok = false;
    issues.push({ severity: "error", code: "EMPTY_RESULT", message: "Nothing visible remains after processing" });
  }
  if (opts.attachmentPointsPx) {
    meta.attachmentPoints = {};
    for (const [name, p] of Object.entries(opts.attachmentPointsPx)) {
      const n = originalPixelToTrimmedNorm(info, p.x, p.y);
      meta.attachmentPoints[name] = { x: r4(n.x), y: r4(n.y) };
    }
  }

  files.backgroundMask = "background-mask.png";
  files.untrimmed = "untrimmed-transparent.png";
  files.processed = "processed-transparent.png";
  files.metadata = "asset-metadata.json";
  await writeMaskPng(mask, image.width, image.height, path.join(outDir, files.backgroundMask));
  await writePng(keyed, path.join(outDir, files.untrimmed));
  await writePng(trimmed, path.join(outDir, files.processed));
  await fs.writeFile(path.join(outDir, files.metadata), JSON.stringify(meta, null, 2));
  return meta;
}
