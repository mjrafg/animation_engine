/**
 * Processes the playground originals through the real asset pipeline (non-destructive).
 * Decisions made from pass-1 diagnostics, like the future agent would:
 *  - none of these props contains its key colour, so every enclosed key-coloured region
 *    (between ladder rungs, inside the swing frame) is background: removeHoles "all";
 *  - disconnected specks under 1% of the visible pixels are removed.
 * Writes assets/processed/<name>/... and assets/processed/summary.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { processAsset, type ProcessOptions } from "../../src/assets/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIG = path.join(HERE, "assets", "originals");
const PROC = path.join(HERE, "assets", "processed");
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(ORIG, "manifest.json"), "utf8"));
  const summary: Record<string, unknown> = {};
  for (const [name, e] of Object.entries<any>(manifest)) {
    const input = path.join(ORIG, e.file);
    if (e.kind === "opaque") {
      const m = await sharp(input).metadata();
      summary[name] = { src: path.relative(HERE, input), width: m.width, height: m.height, res: e.res };
      continue;
    }
    const outDir = path.join(PROC, name);
    const opts: ProcessOptions = {
      removal: { colorTolerance: 18, edgeSoftness: 3 },
      trim: { alphaThreshold: 4, padding: 2 },
      attachmentPointsPx: { ...e.attachmentPointsPx, ...(e.pivotPx ? { __pivot: e.pivotPx } : {}) },
    };
    let meta = await processAsset(input, outDir, opts);
    if (!meta.ok) throw new Error(`${name}: ${JSON.stringify(meta.issues)}`);
    const decisions: string[] = [];
    if (meta.removal?.holes.length) {
      opts.removal = { ...opts.removal, removeHoles: "all" };
      decisions.push(`remove ${meta.removal.holes.length} enclosed key-colour hole(s)`);
    }
    const specks = meta.components.filter((c) => c.id !== 1 && c.share < 0.01).map((c) => c.id);
    if (specks.length) {
      opts.removeComponents = specks;
      decisions.push(`remove specks ${JSON.stringify(specks)}`);
    }
    if (decisions.length) meta = await processAsset(input, outDir, opts);
    const pts = { ...meta.attachmentPoints };
    const pivot = pts.__pivot;
    delete pts.__pivot;
    summary[name] = {
      src: path.relative(HERE, path.join(outDir, meta.files.processed)),
      width: meta.size!.width,
      height: meta.size!.height,
      res: e.res,
      path: meta.path,
      ...(pivot ? { pivot: { x: r4(pivot.x), y: r4(pivot.y) } } : {}),
      ...(Object.keys(pts).length ? { attachmentPoints: pts } : {}),
      ...(meta.detection ? { key: meta.detection.detectedColorHex, confidence: meta.detection.confidence } : {}),
      decisions,
      issues: meta.issues.map((i) => i.code),
    };
    console.log(`${name.padEnd(14)} ${meta.path.padEnd(12)} ${meta.size!.width}x${meta.size!.height} ${meta.detection ? meta.detection.detectedColorHex : ""} ${decisions.join("; ")}`);
  }
  await fs.writeFile(path.join(PROC, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
