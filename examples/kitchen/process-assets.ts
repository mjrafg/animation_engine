/**
 * Runs every original test asset through the real asset pipeline (non-destructively) and writes
 * assets/processed/<name>/{original.png, background-mask.png, untrimmed-transparent.png,
 * processed-transparent.png, asset-metadata.json} plus assets/processed/summary.json.
 *
 * For keyed assets it does what the future agent will do: a first "inspect" pass reads the
 * diagnostics (enclosed holes, disconnected components) and a second pass applies explicit
 * decisions (which holes are real holes, which components are artifacts). The decisions below are
 * made from the numeric diagnostics only.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processAsset, type AssetMetadata, type ProcessOptions } from "../../src/assets/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIG = path.join(HERE, "assets", "originals");
const PROC = path.join(HERE, "assets", "processed");

interface ManifestEntry {
  file: string;
  kind: "keyed" | "transparent" | "opaque";
  pivotPx?: { x: number; y: number };
  attachmentPointsPx?: Record<string, { x: number; y: number }>;
  res: number;
}

export interface ProcessedSummaryEntry {
  name: string;
  path: string;
  /** src relative to the scene directory */
  src: string;
  width: number;
  height: number;
  res: number;
  pivot?: { x: number; y: number };
  attachmentPoints?: Record<string, { x: number; y: number }>;
  diagnostics?: Record<string, unknown>;
  decisions?: string[];
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ORIG, "manifest.json"), "utf8")) as Record<string, ManifestEntry>;
  const summary: Record<string, ProcessedSummaryEntry> = {};

  for (const [name, entry] of Object.entries(manifest)) {
    const input = path.join(ORIG, entry.file);
    if (entry.kind === "opaque") {
      const sharp = (await import("sharp")).default;
      const m = await sharp(input).metadata();
      summary[name] = { name, path: "opaque", src: path.relative(HERE, input), width: m.width!, height: m.height!, res: entry.res };
      continue;
    }
    const outDir = path.join(PROC, name);
    const base: ProcessOptions = {
      mode: "auto",
      detect: { borderSampleSize: 12 },
      removal: { colorTolerance: 18, edgeSoftness: 3 },
      trim: { alphaThreshold: 4, padding: 2 },
      attachmentPointsPx: { ...entry.attachmentPointsPx, ...(entry.pivotPx ? { __pivot: entry.pivotPx } : {}) },
    };
    // Pass 1: inspect
    let meta: AssetMetadata = await processAsset(input, outDir, base);
    if (!meta.ok) throw new Error(`${name}: ${JSON.stringify(meta.issues)}`);
    const decisions: string[] = [];

    // Pass 2: decide from numbers
    const opts: ProcessOptions = structuredClone(base);
    if (meta.path === "color-key" && meta.removal) {
      const holes = meta.removal.holes;
      if (name === "cup_keyed") {
        // The handle hole is the enclosed region to the right of the mug body (x > 300 in the
        // original); the region inside the body is the deliberate key-coloured stripe: keep it.
        const handleHoles = holes.filter((h) => h.centroid.x > 300).map((h) => h.id);
        opts.removal = { ...opts.removal, removeHoles: handleHoles };
        decisions.push(`remove holes ${JSON.stringify(handleHoles)} (inside handle); keep ${JSON.stringify(holes.filter((h) => !handleHoles.includes(h.id)).map((h) => h.id))} (stripe on the mug)`);
      } else if (holes.length) {
        // plant / counter do not contain their key colour anywhere: all enclosed key colour is background
        opts.removal = { ...opts.removal, removeHoles: "all" };
        decisions.push(`remove all ${holes.length} enclosed key-colour holes (subject contains no key colour)`);
      }
    }
    if (meta.components.length > 1) {
      // Keep components that are a meaningful share of the subject; drop tiny isolated specks.
      const main = meta.components[0];
      const artifacts = meta.components.filter((c) => c.id !== main.id && c.share < 0.01).map((c) => c.id);
      if (artifacts.length) {
        opts.removeComponents = artifacts;
        decisions.push(`remove components ${JSON.stringify(artifacts)} (each < 1% of visible pixels, disconnected)`);
      }
    }
    if (decisions.length) meta = await processAsset(input, outDir, opts);

    const pts = { ...meta.attachmentPoints };
    const pivot = pts.__pivot;
    delete pts.__pivot;
    summary[name] = {
      name,
      path: meta.path,
      src: path.relative(HERE, path.join(outDir, meta.files.processed)),
      width: meta.size!.width,
      height: meta.size!.height,
      res: entry.res,
      pivot: pivot ? { x: r4(pivot.x), y: r4(pivot.y) } : undefined,
      attachmentPoints: Object.keys(pts).length ? pts : undefined,
      diagnostics: {
        detection: meta.detection && {
          detectedColorHex: meta.detection.detectedColorHex,
          borderUniformity: meta.detection.borderUniformity,
          confidence: meta.detection.confidence,
        },
        holes: meta.removal?.holes.map((h) => ({ id: h.id, pixelCount: h.pixelCount, removed: h.removed })),
        components: meta.components.map((c) => ({ id: c.id, pixelCount: c.pixelCount })),
        trim: meta.trim && { offsetX: meta.trim.offsetX, offsetY: meta.trim.offsetY, trimmedWidth: meta.trim.trimmedWidth, trimmedHeight: meta.trim.trimmedHeight, originalWidth: meta.trim.originalWidth, originalHeight: meta.trim.originalHeight },
        issues: meta.issues.map((i) => i.code),
      },
      decisions,
    };
    console.log(`${name.padEnd(16)} ${meta.path.padEnd(12)} ${meta.size!.width}x${meta.size!.height} ${decisions.join("; ")}`);
  }
  await fs.writeFile(path.join(PROC, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
