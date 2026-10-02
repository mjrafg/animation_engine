import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(process.argv[2] ?? ".");
const { AnimationEngine } = await import(pathToFileURL(path.join(root, "src/api/engine.ts")).href);
for (const scene of ["examples/kitchen/scene.json", "examples/kitchen/scene.before-feedback.json", "examples/playground/scene.json"]) {
  const engine = await AnimationEngine.fromFile(path.join(root, scene));
  await engine.prepare();
  try {
    const d = engine.scene.duration;
    for (const frame of [0, Math.floor(d / 3), Math.floor(2 * d / 3), d - 1]) {
      const hash = createHash("sha256").update((await engine.renderFrame(frame)).rgba()).digest("hex");
      console.log(`${scene}\t${frame}\t${hash}`);
    }
  } finally { await engine.closeVideoSources(); }
}
