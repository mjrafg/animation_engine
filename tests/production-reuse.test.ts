import { afterAll, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { prepareVideoAsset } from "../src/media/prepare.js";
import { AnimationEngine } from "../src/api/engine.js";
import { tmpDir } from "./helpers.js";
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "../src/render/video.js";
const dir = tmpDir("production-reuse-");
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
it.each([1, 3])("reuses commands with %i workers while preserving exact decoded pixels", async (chunks) => {
  const engine = new AnimationEngine({ canvas: { width: 32, height: 32, fps: 30 }, duration: 12,
    layers: [{ id: "box", fill: "#ff0000", width: 10, height: 10, x: 5, y: 5 }],
    animations: [{ target: "box", property: "x", keyframes: [{ frame: 0, value: 5, interpolation: "step" }, { frame: 6, value: 20 }] }] }, dir);
  await engine.prepare();
  const expected: Buffer[] = [];
  for (let i = 0; i < 12; i++) expected.push(Buffer.from((await engine.renderFrame(i)).rgba()));
  const file = path.join(dir, "master.mkv");
  const result = await engine.renderVideo(file, { intermediate: "lossless-rgb", audio: false, chunks });
  expect(result.timings?.reusedFrames).toBeGreaterThanOrEqual(8);
  const decoded = spawnSync(ffmpegPath(), ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"]);
  expect(decoded.status).toBe(0);
  expect(decoded.stdout).toEqual(Buffer.concat(expected));
  const progress: number[] = [];
  const prepared = await prepareVideoAsset(file, path.join(dir, `prepared-${chunks}`), { fps: 30 }, undefined, (frame) => progress.push(frame));
  expect(prepared.video.frameCount).toBe(12);
  expect(prepared.output.streams[0].nb_read_frames).toBeUndefined();
  expect(progress.at(-1)).toBe(12);
  await engine.closeVideoSources();
});
