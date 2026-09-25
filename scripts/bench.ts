/** Dev helper: time frame rendering for a scene. tsx scripts/bench.ts scene.json [frames] */
import crypto from "node:crypto";
import { AnimationEngine } from "../src/api/engine.js";

async function main() {
  const e = await AnimationEngine.fromFile(process.argv[2]);
  await e.prepare();
  const n = Number(process.argv[3] ?? 30);
  const t0 = performance.now();
  let hash = "";
  for (let f = 0; f < n; f++) hash = crypto.createHash("sha256").update((await e.renderFrame(f)).rgba()).digest("hex");
  const ms = (performance.now() - t0) / n;
  console.log(`${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(1)} fps) incl. RGBA readback; last frame sha256 ${hash.slice(0, 16)}`);
}
main();
