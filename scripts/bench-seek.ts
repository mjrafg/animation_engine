/** Run against another checkout with --engine-root DIR --label main. The same
 * source file is reused, but each label has its own prepared bytes and timing. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = path.resolve(option("--engine-root", "."));
const dir = path.resolve(option("--directory", path.join(os.tmpdir(), "animation-engine-seek-bench")));
const label = option("--label", "fix");
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Invalid benchmark label");
const { prepareVideoAsset } = await import(pathToFileURL(path.join(root, "src/media/prepare.ts")).href);
const { runFFmpeg } = await import(pathToFileURL(path.join(root, "src/media/process.ts")).href);
const { AnimationEngine } = await import(pathToFileURL(path.join(root, "src/api/engine.ts")).href);
await fs.mkdir(dir, { recursive: true });
const input = path.join(dir, "source.mp4");
if (!await fs.stat(input).then(() => true, () => false)) {
  console.log("Generating shared 120s 1920x1080 30fps source (excluded from preparation timing)...");
  await runFFmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30", "-frames:v", "3600", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-y", input]);
}
const preparedDir = path.join(dir, `prepared-${label}`), record = path.join(dir, `preparation-${label}.json`);
let prepared: any;
let preparationMs: number;
const reused = await fs.stat(record).then(() => true, () => false);
if (reused) ({ prepared, preparationMs } = JSON.parse(await fs.readFile(record, "utf8")));
else {
  const start = performance.now();
  prepared = await prepareVideoAsset(input, preparedDir, { fps: 30 });
  preparationMs = performance.now() - start;
  await fs.writeFile(record, JSON.stringify({ prepared, preparationMs }, null, 2));
}
const engine = new AnimationEngine({ canvas: { width: 1920, height: 1080, fps: 30 }, duration: 3600, assets: { video: prepared.asset }, layers: [{ id: "footage", asset: "video", x: 960, y: 540 }], animations: [{ target: "footage", property: "sourceTime", keyframes: [{ frame: 0, value: 0 }, { frame: 3599, value: 3599 / 30 }] }] }, dir);
await engine.prepare();
console.log(`Engine: ${root}`);
console.log(`Preparation: ${preparationMs.toFixed(2)} ms (${reused ? "reused; original measurement" : "fresh"})`);
try {
  for (const frame of [10, 1800, 3590]) {
    const start = performance.now();
    await engine.renderFrame(frame);
    console.log(`renderFrame(${frame}): ${(performance.now() - start).toFixed(2)} ms`);
  }
} finally { await engine.closeVideoSources(); }
