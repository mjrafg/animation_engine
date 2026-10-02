import { afterAll, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { FFmpegFrameSource } from "../src/media/frames.js";
import { prepareVideoAsset } from "../src/media/prepare.js";
import { startEncoder } from "../src/render/video.js";
import { tmpDir } from "./helpers.js";

const dir = tmpDir("ae-long-seek-");
const width = 144,
  height = 16;
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

async function makeFixture(name: string, count: number, fps: number, gop: number) {
  const input = path.join(dir, `${name}.mp4`);
  const encoder = startEncoder({ out: input, width, height, fps, frameCount: count, crf: 0, preset: "ultrafast" });
  try {
    for (let frame = 0; frame < count; frame++) {
      const rgba = Buffer.alloc(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const value = (frame >> Math.floor(x / 12)) & 1 ? 255 : 0;
          rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = value;
          rgba[offset + 3] = 255;
        }
      await encoder.write(rgba);
    }
    await encoder.finish();
  } catch (e) {
    await encoder.abort();
    throw e;
  }
  return prepareVideoAsset(input, path.join(dir, name), { fps, gop, threads: 2 });
}
const readBarcode = (data: Buffer) =>
  Array.from({ length: 12 }, (_, bit) => (data[(8 * width + bit * 12 + 6) * 4] > 128 ? 2 ** bit : 0)).reduce((a, b) => a + b, 0);
let long: ReturnType<typeof makeFixture> | undefined;
const fixture = () => (long ??= makeFixture("long", 3600, 30, 15));
const indices = [
  0, 1, 14, 15, 16, 29, 30, 31, 899, 900, 901, 1799, 1800, 1801, 2699, 2700, 2701, 3584, 3585, 3586, 3599, 0, 3598, 1800, 1799, 1801,
];

it.each(["random", "sequential"] as const)(
  "long CFR barcode: exact keyframe boundaries, endpoints and restarts in %s mode",
  async (mode) => {
    const prepared = await fixture();
    expect(prepared.video.frameCount).toBe(3600);
    const source = new FFmpegFrameSource(prepared.file, prepared.video, { mode, cacheBytes: 0, maxForwardFrames: 8 });
    try {
      for (const index of indices) expect(readBarcode((await source.getFrame(index)).data), `frame ${index}`).toBe(index);
      console.info(`long CFR ${mode}: ${indices.length} indices, zero mismatches`);
    } finally {
      await source.close();
    }
  },
  120000,
);

it("fractional CFR barcode: exact frame selection with a non-default GOP", async () => {
  const prepared = await makeFixture("fractional", 180, 30000 / 1001, 7);
  expect(prepared.video.frameCount).toBe(180);
  const indices = [0, 6, 7, 8, 13, 14, 15, 174, 175, 176, 179, 1, 178];
  for (const mode of ["random", "sequential"] as const) {
    const source = new FFmpegFrameSource(prepared.file, prepared.video, { mode, cacheBytes: 0, maxForwardFrames: 4 });
    try {
      for (const index of indices) expect(readBarcode((await source.getFrame(index)).data), `${mode} frame ${index}`).toBe(index);
      console.info(`fractional CFR ${mode}: ${indices.length} indices, zero mismatches`);
    } finally {
      await source.close();
    }
  }
}, 120000);

it("random seek near the end stays within 3x the start plus 100ms scheduling tolerance", async () => {
  const prepared = await fixture();
  const source = new FFmpegFrameSource(prepared.file, prepared.video, { mode: "random", cacheBytes: 0 });
  const early: number[] = [],
    late: number[] = [];
  try {
    // Warm both regions and initialize the once-per-source packet index.
    await source.getFrame(10);
    await source.getFrame(3590);
    for (let round = 0; round < 5; round++) {
      for (const [index, samples] of [
        [10, early],
        [3590, late],
      ] as const) {
        const start = performance.now();
        expect(readBarcode((await source.getFrame(index)).data)).toBe(index);
        samples.push(performance.now() - start);
      }
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[2];
    const nearStart = median(early),
      nearEnd = median(late);
    console.info(`seek medians: start=${nearStart.toFixed(2)}ms end=${nearEnd.toFixed(2)}ms; 10 indices, zero mismatches`);
    expect(nearEnd).toBeLessThanOrEqual(nearStart * 3 + 100);
  } finally {
    await source.close();
  }
}, 120000);
