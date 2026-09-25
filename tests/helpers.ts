import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { RgbaImage } from "../src/assets/image.js";

export function tmpDir(prefix = "ae-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Minimal valid scene document (raw JSON). */
export function baseScene(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    canvas: { width: 200, height: 100, fps: 10, background: "#000000" },
    duration: 20,
    ...extra,
  };
}

/** Draw with canvas 2D (anti-aliased) and return straight RGBA. */
export function drawImage(w: number, h: number, draw: (ctx: SKRSContext2D) => void): RgbaImage {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  draw(ctx);
  const d = ctx.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data: new Uint8ClampedArray(d) };
}

export function pixel(img: { width: number; data: Uint8ClampedArray | Buffer }, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export async function writeTestPng(file: string, w: number, h: number, draw: (ctx: SKRSContext2D) => void) {
  const c = createCanvas(w, h);
  draw(c.getContext("2d"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, await c.encode("png"));
}
