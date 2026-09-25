/**
 * Simulates the future AI feedback loop using ONLY the agent tool API (no renderer changes):
 *
 *   load scene -> render preview -> measure_layout -> edit numeric scene values -> render again
 *
 * Problem found by inspecting iteration-1 previews: at the pick-up frame the hand is ~200px left
 * of and ~70px above the cup waiting on the counter, so the hand-off "teleports" the cup.
 *
 * Fix, expressed purely as data edits:
 *   1. Adjust the reach pose keyframes (right_upper_arm / right_forearm rotation at the pick-up
 *      frame) until the held cup's `base_center` attachment point (world space, from
 *      measure_layout) lands on the counter surface at the cup's spot. A tiny Newton iteration on
 *      two numbers stands in for the agent's reasoning.
 *   2. Keep the held cup upright (its rotation keyframe = -(upper + fore)).
 *   3. Move `cup_on_counter` so its base sits exactly where the held cup's base is.
 *
 * Writes out/feedback-loop/{before,after}_*.png, log.json and the corrected scene.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineSession } from "../../src/api/tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out", "feedback-loop");
const PICK = 155;
const log: unknown[] = [];

async function call(s: EngineSession, tool: string, args: unknown) {
  const r = await s.call(tool, args);
  if (!r.ok) throw new Error(`${tool} failed: ${JSON.stringify(r.errors, null, 2)}`);
  return r.result as any;
}

async function main() {
  const s = new EngineSession();
  await call(s, "load_scene", { path: path.join(HERE, "scene.json") });

  const measure = async () => {
    const layout = await call(s, "measure_layout", { frame: PICK, layers: ["cup_in_hand", "cup_on_counter", "counter"] });
    const by = Object.fromEntries(layout.layers.map((l: any) => [l.id, l]));
    return {
      held: by.cup_in_hand.attachmentPoints.base_center.world as { x: number; y: number },
      heldRotation: by.cup_in_hand.worldRotation as number,
      waiting: by.cup_on_counter.attachmentPoints.base_center.world as { x: number; y: number },
      counterTop: by.counter.attachmentPoints.top_left.world.y as number,
    };
  };

  // --- inspect (before) ----------------------------------------------------------------------
  for (const f of [PICK]) {
    await call(s, "render_preview", { frame: f, out: path.join(OUT, `before_${f}.png`) });
    await call(s, "render_debug_preview", { frame: f, out: path.join(OUT, `before_debug_${f}.png`), options: { only: ["cup_in_hand", "cup_on_counter", "right_hand", "right_forearm", "right_upper_arm", "counter"] } });
  }
  const m0 = await measure();
  // Target: cup base resting on the counter slab (slab top + 7px) at the cup's current x.
  const target = { x: m0.waiting.x, y: Math.round(m0.counterTop + 7) };
  log.push({ step: "measure-before", ...m0, target, error: { dx: m0.held.x - target.x, dy: m0.held.y - target.y } });
  console.log("before:", JSON.stringify({ held: m0.held, waiting: m0.waiting, target }));

  // --- adjust the reach pose (two numbers) until the held cup base hits the target ------------
  const scene = (await call(s, "get_scene", {})) as any;
  const kfValue = (target: string, prop: string) =>
    scene.animations.find((a: any) => a.target === target && a.property === prop).keyframes.find((k: any) => k.frame === PICK).value as number;
  let pose = { upper: kfValue("right_upper_arm", "rotation"), fore: kfValue("right_forearm", "rotation") };

  const apply = async (p: { upper: number; fore: number }) => {
    await call(s, "update_keyframe", { target: "right_upper_arm", property: "rotation", frame: PICK, patch: { value: p.upper } });
    await call(s, "update_keyframe", { target: "right_forearm", property: "rotation", frame: PICK, patch: { value: p.fore } });
    await call(s, "update_keyframe", { target: "cup_in_hand", property: "rotation", frame: PICK, patch: { value: -(p.upper + p.fore) } });
    return measure();
  };

  for (let iter = 0; iter < 12; iter++) {
    const m = await apply(pose);
    const e = { x: m.held.x - target.x, y: m.held.y - target.y };
    log.push({ step: "iterate", iter, pose: { ...pose }, held: m.held, error: e });
    console.log(`iter ${iter}: upper=${pose.upper.toFixed(3)} fore=${pose.fore.toFixed(3)} err=(${e.x.toFixed(2)}, ${e.y.toFixed(2)})`);
    if (Math.hypot(e.x, e.y) < 0.25) break;
    // finite-difference Jacobian (1 degree steps), measured through the tool API
    const h = 1;
    const mu = await apply({ upper: pose.upper + h, fore: pose.fore });
    const mf = await apply({ upper: pose.upper, fore: pose.fore + h });
    const J = [
      [(mu.held.x - m.held.x) / h, (mf.held.x - m.held.x) / h],
      [(mu.held.y - m.held.y) / h, (mf.held.y - m.held.y) / h],
    ];
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    const du = (J[1][1] * -e.x - J[0][1] * -e.y) / det;
    const df = (-J[1][0] * -e.x + J[0][0] * -e.y) / det;
    const scale = Math.min(1, 20 / Math.max(Math.abs(du), Math.abs(df))); // max 20° per step
    pose = { upper: pose.upper + du * scale, fore: pose.fore + df * scale };
  }
  pose = { upper: +pose.upper.toFixed(2), fore: +pose.fore.toFixed(2) };
  let m = await apply(pose);

  // --- put the waiting cup exactly where the held cup's base is -----------------------------
  await call(s, "update_layer", { id: "cup_on_counter", patch: { x: +m.held.x.toFixed(2), y: +m.held.y.toFixed(2) } });
  m = await measure();
  log.push({ step: "measure-after", pose, ...m, residual: { dx: m.held.x - m.waiting.x, dy: m.held.y - m.waiting.y } });
  console.log("after:", JSON.stringify({ pose, held: m.held, waiting: m.waiting, heldRotation: m.heldRotation }));

  for (const f of [PICK]) {
    await call(s, "render_preview", { frame: f, out: path.join(OUT, `after_${f}.png`) });
    await call(s, "render_debug_preview", { frame: f, out: path.join(OUT, `after_debug_${f}.png`), options: { only: ["cup_in_hand", "cup_on_counter", "right_hand", "right_forearm", "right_upper_arm", "counter"] } });
  }
  await call(s, "save_scene", { path: path.join(HERE, "scene.json") });
  await fs.writeFile(path.join(OUT, "log.json"), JSON.stringify(log, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
