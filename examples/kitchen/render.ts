/**
 * Renders the kitchen deliverables from scene.json:
 *   out/previews/frame_NNNN.png   normal previews
 *   out/debug/frame_NNNN.png      debug previews (bounds, ids, z, pivots, centres, attachment points)
 *   out/layout/frame_NNNN.json    measure_layout output
 *   out/layout/summary.json       selected geometry across frames (parent motion, rotation, camera, scale)
 *   out/kitchen.mp4               final video (raw RGBA piped into FFmpeg, with audio)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnimationEngine } from "../../src/api/engine.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const pad = (n: number) => String(n).padStart(4, "0");

async function main() {
  const engine = await AnimationEngine.fromFile(path.join(HERE, "scene.json"));
  await engine.prepare();

  const previewFrames = [45, 100, 140, 155, 230, 320];
  for (const f of previewFrames) {
    await engine.renderPreview(f, path.join(OUT, "previews", `frame_${pad(f)}.png`));
    await engine.renderDebugPreview(f, path.join(OUT, "debug", `frame_${pad(f)}.png`), { attachmentPoints: true });
  }
  // A readable debug view of just the arm/cup chain at the hand-off
  await engine.renderDebugPreview(155, path.join(OUT, "debug", "frame_0155_arm_only.png"), {
    only: ["torso", "right_upper_arm", "right_forearm", "right_hand", "cup_in_hand", "cup_on_counter", "counter", "head"],
  });

  const layoutFrames = [0, 50, 100, 155, 200, 230];
  const pick = ["character", "torso", "head", "right_upper_arm", "right_forearm", "right_hand", "cup_in_hand", "counter", "steam"];
  const summary: Record<string, unknown> = {};
  for (const f of layoutFrames) {
    const layout = engine.measureLayout(f);
    await fs.mkdir(path.join(OUT, "layout"), { recursive: true });
    await fs.writeFile(path.join(OUT, "layout", `frame_${pad(f)}.json`), JSON.stringify(layout, null, 2) + "\n");
    summary[f] = {
      camera: { x: layout.camera.x, y: layout.camera.y, scale: layout.camera.scale },
      drawOrder: layout.drawOrder,
      layers: Object.fromEntries(
        layout.layers
          .filter((l) => pick.includes(l.id))
          .map((l) => [
            l.id,
            {
              visible: l.visible,
              z: l.z,
              worldPivot: l.worldPivot,
              worldRotation: l.worldRotation,
              worldBounds: l.worldBounds,
              screenBounds: l.screenBounds,
              ...(Object.keys(l.attachmentPoints).length
                ? { attachmentPoints: Object.fromEntries(Object.entries(l.attachmentPoints).map(([k, v]) => [k, v.world])) }
                : {}),
            },
          ]),
      ),
    };
  }
  await fs.writeFile(path.join(OUT, "layout", "summary.json"), JSON.stringify(summary, null, 2) + "\n");

  const t0 = Date.now();
  const r = await engine.renderVideo(path.join(OUT, "kitchen.mp4"), {
    onProgress: (f, total) => {
      if (f % 30 === 0) process.stdout.write(`\rframe ${f}/${total}`);
    },
  });
  console.log(`\n${r.file}: ${r.frames} frames, ${r.seconds}s, rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
