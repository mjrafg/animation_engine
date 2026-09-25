import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectBackground } from "../src/assets/background.js";
import { deltaE, rgbToLab } from "../src/assets/color.js";
import { findComponents, removeComponents } from "../src/assets/components.js";
import { readRgba } from "../src/assets/image.js";
import { processAsset } from "../src/assets/pipeline.js";
import { removeBackground } from "../src/assets/removal.js";
import { trimTransparent } from "../src/assets/trim.js";
import { drawImage, pixel, tmpDir, writeTestPng } from "./helpers.js";

const BLUE = { r: 20, g: 169, b: 231 };
const blueHex = "#14a9e7";

/** A white mug-like block on blue, with a key-coloured stripe enclosed inside it. */
const mug = () =>
  drawImage(120, 100, (ctx) => {
    ctx.fillStyle = blueHex;
    ctx.fillRect(0, 0, 120, 100);
    ctx.fillStyle = "#f5f5f0";
    ctx.beginPath();
    ctx.roundRect(30, 20, 60, 60, 10);
    ctx.fill();
    ctx.fillStyle = blueHex; // same colour as the background, fully enclosed
    ctx.fillRect(40, 45, 40, 10);
  });

describe("background border detection", () => {
  it("detects the key colour from the border and reports full uniformity", () => {
    const d = detectBackground(mug(), { borderSampleSize: 10 });
    expect(d.ok).toBe(true);
    expect(d.detectedColor).toEqual(BLUE);
    expect(d.borderUniformity).toBe(1);
    expect(d.confidence).toBe(1);
    expect(d.issues).toEqual([]);
  });

  it("works for any key colour (green, magenta) without being told", () => {
    for (const hex of ["#23c43a", "#e020c8", "#00e5e5"]) {
      const img = drawImage(60, 60, (ctx) => {
        ctx.fillStyle = hex;
        ctx.fillRect(0, 0, 60, 60);
        ctx.fillStyle = "#553311";
        ctx.fillRect(20, 20, 20, 20);
      });
      const d = detectBackground(img);
      expect(d.detectedColorHex).toBe(hex);
    }
  });

  it("uses a robust statistic: a subject touching one edge does not shift the colour", () => {
    const img = drawImage(100, 100, (ctx) => {
      ctx.fillStyle = blueHex;
      ctx.fillRect(0, 0, 100, 100);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(40, 60, 20, 40); // touches the bottom edge (5% of the border band)
    });
    const d = detectBackground(img, { borderSampleSize: 8 });
    expect(d.detectedColor).toEqual(BLUE);
    expect(d.ok).toBe(true);
    expect(d.issues.map((i) => i.code)).toContain("SUBJECT_NEAR_EDGE");
    expect(d.sideUniformity.bottom).toBeLessThan(0.97);
    expect(d.confidence).toBeLessThan(1);
  });

  it("fails the contract when the border is not uniform", () => {
    const img = drawImage(100, 100, (ctx) => {
      for (let x = 0; x < 100; x += 10) {
        ctx.fillStyle = x % 20 ? "#ff0000" : "#0000ff";
        ctx.fillRect(x, 0, 10, 100);
      }
    });
    const d = detectBackground(img);
    expect(d.ok).toBe(false);
    expect(d.issues[0].code).toBe("BORDER_NOT_UNIFORM");
  });

  it("warns about gradient backgrounds", () => {
    const img = drawImage(100, 100, (ctx) => {
      const g = ctx.createLinearGradient(0, 0, 0, 100);
      g.addColorStop(0, "#1070e0");
      g.addColorStop(1, "#10b0e0");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 100, 100);
    });
    const d = detectBackground(img, { uniformityTolerance: 40 });
    expect(d.issues.map((i) => i.code)).toContain("BACKGROUND_GRADIENT");
  });
});

describe("edge-connected flood fill removal", () => {
  it("removes only border-connected background and keeps enclosed same-colour pixels", () => {
    const img = mug();
    const r = removeBackground(img, BLUE, { edgeSoftness: 2 });
    expect(pixel(r.image, 2, 2)[3]).toBe(0); // outside
    expect(pixel(r.image, 60, 30)[3]).toBe(255); // mug body
    const stripe = pixel(r.image, 60, 50);
    expect(stripe[3]).toBe(255); // enclosed key colour preserved
    expect(deltaE(rgbToLab(stripe[0], stripe[1], stripe[2]), rgbToLab(BLUE.r, BLUE.g, BLUE.b))).toBeLessThan(3);
    expect(r.holes).toHaveLength(1);
    expect(r.holes[0].bounds).toEqual({ left: 40, top: 45, right: 80, bottom: 55 });
    expect(r.stats.preservedEnclosedPixels).toBe(400);
  });

  it("removes an enclosed region only when explicitly asked (by id)", () => {
    const r = removeBackground(mug(), BLUE, { removeHoles: [1] });
    expect(pixel(r.image, 60, 50)[3]).toBe(0);
    expect(r.holes[0].removed).toBe(true);
    expect(removeBackground(mug(), BLUE, { removeHoles: "all" }).holes[0].removed).toBe(true);
  });

  it("naive global keying would have destroyed the stripe (documents why flood fill matters)", () => {
    const img = mug();
    let globalRemoved = 0;
    for (let i = 0; i < img.width * img.height; i++) {
      const p = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
      if (deltaE(rgbToLab(p[0], p[1], p[2]), rgbToLab(BLUE.r, BLUE.g, BLUE.b)) <= 18) globalRemoved++;
    }
    const r = removeBackground(img, BLUE);
    expect(globalRemoved - r.stats.removedPixels).toBeGreaterThanOrEqual(400);
  });

  it("produces soft partial alpha on anti-aliased edges and despills them", () => {
    const img = drawImage(80, 80, (ctx) => {
      ctx.fillStyle = blueHex;
      ctx.fillRect(0, 0, 80, 80);
      ctx.fillStyle = "#e03020"; // red disc: anti-aliased red/blue edge
      ctx.beginPath();
      ctx.arc(40, 40, 22.3, 0, Math.PI * 2);
      ctx.fill();
    });
    const r = removeBackground(img, BLUE, { edgeSoftness: 3 });
    expect(r.stats.partialAlphaPixels).toBeGreaterThan(20);
    // every partially transparent pixel must be (close to) the subject's red, not purple/blue
    let worst = 0;
    for (let i = 0; i < 80 * 80; i++) {
      const a = r.image.data[i * 4 + 3];
      if (a > 20 && a < 255) {
        const blueExcess = r.image.data[i * 4 + 2] - 32;
        worst = Math.max(worst, blueExcess);
      }
    }
    expect(worst).toBeLessThan(25);
    // without despill the same pixels keep a strong blue tint
    const raw = removeBackground(img, BLUE, { edgeSoftness: 3, despill: false });
    let rawWorst = 0;
    for (let i = 0; i < 80 * 80; i++) {
      const a = raw.image.data[i * 4 + 3];
      if (a > 20 && a < 255) rawWorst = Math.max(rawWorst, raw.image.data[i * 4 + 2] - 32);
    }
    expect(rawWorst).toBeGreaterThan(60);
  });

  // Regression: kitchen counter. A solid grey outline next to a white fill on green was read
  // as a white/green mix and "despilled" to pink.
  it("regression: solid grey outline next to white fill is not mistaken for a mix (no pink fringe)", () => {
    const img = drawImage(80, 60, (ctx) => {
      ctx.fillStyle = "#23c43a";
      ctx.fillRect(0, 0, 80, 60);
      ctx.fillStyle = "#f1efe9";
      ctx.strokeStyle = "#bdb8ad";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(15.5, 15.5, 50, 30, 6);
      ctx.fill();
      ctx.stroke();
    });
    const r = removeBackground(img, { r: 35, g: 196, b: 58 }, { edgeSoftness: 3 });
    for (let i = 0; i < 80 * 60; i++) {
      const [R, G, B, A] = [r.image.data[i * 4], r.image.data[i * 4 + 1], r.image.data[i * 4 + 2], r.image.data[i * 4 + 3]];
      if (A < 30) continue;
      // grey/white stay neutral: no channel far from the others (pink would be R,B >> G)
      expect(Math.max(R, G, B) - Math.min(R, G, B), `pixel ${i % 80},${Math.floor(i / 80)} = ${[R, G, B, A]}`).toBeLessThan(40);
    }
  });

  // Regression: cup handle. A thin dark outline's contaminated edge pixels explained themselves
  // with an equally contaminated neighbour and kept a blue tint at full alpha.
  it("regression: thin outline edges on blue do not keep blue specks", () => {
    const img = drawImage(80, 80, (ctx) => {
      ctx.fillStyle = blueHex;
      ctx.fillRect(0, 0, 80, 80);
      ctx.strokeStyle = "#5a5a5a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(40, 40, 25, 0.3, 2.8);
      ctx.stroke();
    });
    const r = removeBackground(img, BLUE, { edgeSoftness: 3 });
    for (let i = 0; i < 80 * 80; i++) {
      const [R, G, B, A] = [r.image.data[i * 4], r.image.data[i * 4 + 1], r.image.data[i * 4 + 2], r.image.data[i * 4 + 3]];
      if (A < 60) continue;
      expect(B - R, `pixel ${i % 80},${Math.floor(i / 80)} = ${[R, G, B, A]}`).toBeLessThan(35);
    }
  });
});

describe("trim_transparent", () => {
  const img = drawImage(100, 80, (ctx) => {
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(30, 20, 25, 10);
    ctx.fillStyle = "rgba(0,0,255,0.01)"; // alpha 3: below the threshold
    ctx.fillRect(0, 0, 5, 5);
  });

  it("crops to visible pixels and reports offsets", () => {
    const { image, info } = trimTransparent(img, { alphaThreshold: 4 });
    expect(info).toMatchObject({ originalWidth: 100, originalHeight: 80, trimmedWidth: 25, trimmedHeight: 10, offsetX: 30, offsetY: 20 });
    expect([image.width, image.height]).toEqual([25, 10]);
    expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it("applies padding clamped to the image", () => {
    const { info } = trimTransparent(img, { alphaThreshold: 4, padding: 8 });
    expect(info).toMatchObject({ trimmedWidth: 41, trimmedHeight: 26, offsetX: 22, offsetY: 12 });
    const big = trimTransparent(img, { alphaThreshold: 4, padding: 50 }).info;
    expect(big).toMatchObject({ offsetX: 0, offsetY: 0, trimmedWidth: 100, trimmedHeight: 80 });
  });

  it("threshold 0 includes faint pixels; empty images are flagged", () => {
    expect(trimTransparent(img, { alphaThreshold: 0 }).info.offsetX).toBe(0);
    expect(trimTransparent(drawImage(10, 10, () => {})).info.empty).toBe(true);
  });
});

describe("connected components", () => {
  const img = drawImage(100, 100, (ctx) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(10, 10, 50, 50); // 2500 px
    ctx.fillRect(80, 80, 5, 5); // 25 px speck
    ctx.fillRect(70, 10, 10, 10); // 100 px
  });

  it("finds disconnected components sorted by size with stable ids", () => {
    const { components } = findComponents(img, 8);
    expect(components.map((c) => [c.id, c.pixelCount])).toEqual([
      [1, 2500],
      [2, 100],
      [3, 25],
    ]);
    expect(components[2].bounds).toEqual({ left: 80, top: 80, right: 85, bottom: 85 });
  });

  it("removes only the selected component", () => {
    const r = removeComponents(img, [3], 8);
    expect(r.removedPixels).toBe(25);
    expect(pixel(r.image, 82, 82)[3]).toBe(0);
    expect(pixel(r.image, 75, 15)[3]).toBe(255);
    expect(findComponents(r.image, 8).components).toHaveLength(2);
  });
});

describe("asset pipeline", () => {
  it("path B (colour key): non-destructive, writes all artefacts, trims", async () => {
    const dir = tmpDir();
    const src = path.join(dir, "cup.png");
    await writeTestPng(src, 120, 100, (ctx) => {
      ctx.fillStyle = blueHex;
      ctx.fillRect(0, 0, 120, 100);
      ctx.fillStyle = "#f5f5f0";
      ctx.fillRect(30, 20, 60, 60);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(100, 85, 3, 3); // speck
    });
    const before = fs.readFileSync(src);
    const out = path.join(dir, "out");
    const meta = await processAsset(src, out, { trim: { padding: 0 }, attachmentPointsPx: { corner: { x: 30, y: 20 } } });
    expect(meta.ok).toBe(true);
    expect(meta.path).toBe("color-key");
    expect(meta.detection!.detectedColor).toEqual(BLUE);
    expect(fs.readFileSync(src).equals(before)).toBe(true);
    for (const f of ["original.png", "background-mask.png", "untrimmed-transparent.png", "processed-transparent.png", "asset-metadata.json"]) {
      expect(fs.existsSync(path.join(out, f)), f).toBe(true);
    }
    expect(fs.readFileSync(path.join(out, "original.png")).equals(before)).toBe(true);
    expect(meta.components.map((c) => c.pixelCount)).toEqual([3600, 9]);
    expect(meta.issues.map((i) => i.code)).toContain("MULTIPLE_COMPONENTS");
    expect(meta.trim).toMatchObject({ offsetX: 30, offsetY: 20, trimmedWidth: 73, trimmedHeight: 68 });

    // second run: drop the speck by id -> tight trim; attachment point converted to normalised
    const meta2 = await processAsset(src, out, { trim: { padding: 0 }, removeComponents: [2], attachmentPointsPx: { corner: { x: 30, y: 20 } } });
    expect(meta2.trim).toMatchObject({ offsetX: 30, offsetY: 20, trimmedWidth: 60, trimmedHeight: 60 });
    expect(meta2.attachmentPoints!.corner).toEqual({ x: 0, y: 0 });
    const { image } = await readRgba(path.join(out, "processed-transparent.png"));
    expect([image.width, image.height]).toEqual([60, 60]);
  });

  it("path A (native alpha): skips colour keying, validates alpha, trims", async () => {
    const dir = tmpDir();
    const src = path.join(dir, "arm.png");
    await writeTestPng(src, 90, 70, (ctx) => {
      ctx.fillStyle = "#14a9e7"; // would be keyed away if routed through path B
      ctx.beginPath();
      ctx.arc(40, 30, 15, 0, Math.PI * 2);
      ctx.fill();
    });
    const meta = await processAsset(src, path.join(dir, "out"), { trim: { padding: 1 } });
    expect(meta.path).toBe("native-alpha");
    expect(meta.detection).toBeUndefined();
    expect(meta.alpha.partialFraction).toBeGreaterThan(0);
    expect(meta.trim).toMatchObject({ offsetX: 24, offsetY: 14, trimmedWidth: 32, trimmedHeight: 32 });
    const { image } = await readRgba(path.join(dir, "out", "processed-transparent.png"));
    expect(pixel(image, 16, 16)).toEqual([20, 169, 231, 255]);
  });

  it("refuses contract-violating backgrounds unless forced", async () => {
    const dir = tmpDir();
    const src = path.join(dir, "bad.png");
    await writeTestPng(src, 60, 60, (ctx) => {
      for (let x = 0; x < 60; x += 6) {
        ctx.fillStyle = x % 12 ? "#ff0000" : "#00ff00";
        ctx.fillRect(x, 0, 6, 60);
      }
    });
    const meta = await processAsset(src, path.join(dir, "out"));
    expect(meta.ok).toBe(false);
    expect(meta.issues[0].code).toBe("BORDER_NOT_UNIFORM");
    expect(fs.existsSync(path.join(dir, "out", "processed-transparent.png"))).toBe(false);
  });
});
