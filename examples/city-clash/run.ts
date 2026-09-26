/**
 * "City Clash": two ORIGINAL 3D characters, Volt (armoured robot) and Crag (stone brute), square
 * off on a city street at dusk. 10 s, 1280x720, 24 fps.
 *
 *   npx tsx examples/city-clash/run.ts [--preview] [--quality draft|standard|high]
 *
 * Characters, set and clips come from assets/3d/src/build_heroes.py. The performance is only
 * high-level character actions (walk, guard, roar, expressions) and interactions (the custom
 * `strike` definition from assets/interactions/strike.json and the built-in `push`); only the
 * camera move is keyframed.
 *
 *   0.0-2.2  both walk toward each other from opposite ends of the street
 *   2.3-4.1  Crag roars (arms spread, angry face); Volt raises its guard
 *   4.2-5.6  Volt steps in and strikes Crag's chest; Crag is knocked back a step
 *   5.8-7.6  Crag answers with a two-handed shove; Volt is pushed back
 *   7.8-10   both square up in guard; Crag roars again as the camera closes in
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ops from "../../src/api/operations.js";
import * as ch from "../../src/characters/operations.js";
import * as ops3d from "../../src/scene3d/operations.js";
import { ffmpegPath } from "../../src/render/video.js";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager } from "../../src/workspace/workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out");
const FPS = 24;
const F = (s: number) => Math.round(s * FPS);
const preview = process.argv.includes("--preview");
const qi = process.argv.indexOf("--quality");
const quality = (qi > 0 ? process.argv[qi + 1] : "high") as "draft" | "standard" | "high";

// EEVEE bloom for the glowing visor, lava and lit windows (backend render tuning hook)
process.env.VE3D_TUNE = JSON.stringify({ "eevee.use_bloom": true, "eevee.bloom_intensity": 0.06, "eevee.bloom_threshold": 0.9, "eevee.bloom_radius": 5.5 });

async function main() {
  fs.rmSync(path.join(OUT, "ws"), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const mgr = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: { characters: path.join(ROOT, "assets", "characters"), interactions: path.join(ROOT, "assets", "interactions") } });
  const ws = mgr.create("clash");
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "volt"));
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "crag"));
  await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "city.glb"), origin: {} }, { assetId: "city" });
  ws.defineInteraction(JSON.parse(fs.readFileSync(mgr.resolveLibraryFile("interactions", "strike.json"), "utf8")));
  const ctx = () => ws.characterContext();

  const s = "city_clash";
  await ws.createScene({ sceneId: s, kind: "3d", canvas: { width: 1280, height: 720, fps: FPS }, duration: 10 * FPS });
  await ws.mutateScene(s, (d) =>
    ops3d.addEntities3D(d, {
      objects: [{ id: "city", asset: "city" }],
      lights: [
        { id: "sun", type: "sun", intensity: 2.6, color: "#ffb27a", rotation: { x: -14, y: -62, z: 0 }, size: 2 },
        { id: "sky_fill", type: "area", intensity: 260, color: "#6f8fd6", position: { x: -3, y: 4.5, z: 6 }, rotation: { x: -35, y: -25, z: 0 }, size: 5, shadows: false },
        { id: "rim", type: "area", intensity: 520, color: "#8fb7ff", position: { x: 1, y: 3.2, z: -4.5 }, rotation: { x: -150, y: 0, z: 0 }, size: 3, shadows: false },
        { id: "lamp_pool", type: "point", intensity: 380, color: "#ffc98a", position: { x: 0.5, y: 4.2, z: -1.5 }, size: 0.4 },
      ],
    }),
  );
  await ws.mutateScene(s, (d) =>
    ops3d.setSettings3D(d, {
      camera: { position: { x: -0.9, y: 1.0, z: 5.8 }, lookAt: { x: 0.4, y: 1.25, z: 0 }, fov: 40 },
      world: { color: "#22335a", strength: 0.55 },
      render: { quality, engine: "eevee" },
    }),
  );
  // slow low-angle dolly toward the fighters (the only hand-made keys)
  const cam = (prop: string, keys: [number, number][]) => ({ type: "track.set", target: "camera", property: prop, keyframes: keys.map(([t, v]) => ({ frame: F(t), value: v, interpolation: "ease-in-out" })) });
  await ws.mutateScene(s, (d) =>
    ops.applyTimelineOps(d, [
      cam("position.x", [[0, -0.9], [5, 0.3], [9.95, 1.4]]),
      cam("position.z", [[0, 5.8], [5, 4.8], [9.95, 3.9]]),
      cam("position.y", [[0, 1.0], [9.95, 0.8]]),
      cam("lookAt.y", [[0, 1.2], [9.95, 1.4]]),
    ]),
  );

  await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "volt", character: "volt", position: { x: -3.2, y: 0, z: 0.4 }, facing: "right" }, ctx()));
  await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "crag", character: "crag", position: { x: 3.8, y: 0, z: -0.4 }, facing: "left" }, ctx()));
  const act = (who: string, list: Record<string, unknown>[]) => ws.mutateScene(s, (d) => ch.applyCharacterActions(d, who, list.map((action) => ({ type: "add", action })), ctx()));
  await act("volt", [
    { action: "walk", start: 0, duration: 2.2, to: { x: -0.35, z: 0.05 } },
    { action: "guard", start: 2.35, duration: 1.75 },
    { action: "angry", start: 2.3, duration: 7.7 },
    { action: "guard", start: 7.75, duration: 2.25 },
  ]);
  await act("crag", [
    { action: "walk", start: 0, duration: 2.2, to: { x: 1.15, z: -0.05 } },
    { action: "roar", start: 2.35, duration: 1.6 },
    { action: "surprised", start: 4.9, duration: 0.8 },
    { action: "angry", start: 5.7, duration: 2.2 },
    { action: "guard", start: 7.75, duration: 0.6 },
    { action: "roar", start: 8.4, duration: 1.6 },
  ]);
  // the roar expression (angry brow + open mouth) runs with both roar gestures
  await ws.mutateScene(s, (d) =>
    ch.applyCharacterActions(d, "crag", [
      { type: "add", action: { action: "expression", expression: "roar", start: 2.45, duration: 1.4 } },
      { type: "add", action: { action: "expression", expression: "roar", start: 8.5, duration: 1.5 } },
    ], ctx()),
  );
  const r = await ws.mutateScene(s, (d) =>
    ch.applyInteractionOps(d, [
      { type: "add", interaction: { id: "strike", interaction: "strike", actors: ["volt", "crag"], start: 4.2, duration: 1.4 } },
      { type: "add", interaction: { id: "shove", interaction: "push", actors: ["crag", "volt"], start: 5.8, duration: 1.8 } },
    ], ctx()),
  );
  console.log("warnings:", JSON.stringify(r.warnings.map((w) => w.message)));
  const tl: any = await ws.inspectInteractions(s);
  for (const ix of tl.interactions) console.log(ix.id, ix.interaction, `${ix.start}-${ix.end}s`, "distance", ix.alignment.distance, JSON.stringify(ix.injectedActions));

  if (preview) {
    for (const t of [1.2, 3.2, 4.95, 6.7, 9.3]) {
      const a = await ws.renderPreview(s, F(t), { quality });
      fs.copyFileSync(ws.abs(a.relativePath), path.join(OUT, `preview_${t}.png`));
      console.log("preview", t);
    }
    return;
  }
  // render in chunks kept on disk (out/parts), so an interrupted run resumes where it stopped;
  // the chunks share one encoding and are joined without re-encoding
  const jobs = new RenderJobs(ws);
  const t0 = Date.now();
  const parts = path.join(OUT, "parts");
  fs.mkdirSync(parts, { recursive: true });
  const CHUNK = 40;
  const total = 10 * FPS;
  const files: string[] = [];
  for (let a = 0; a < total; a += CHUNK) {
    const b = Math.min(total, a + CHUNK);
    const file = path.join(parts, `frames_${String(a).padStart(3, "0")}_${String(b).padStart(3, "0")}.mp4`);
    files.push(file);
    if (fs.existsSync(file)) {
      console.log(`chunk ${a}-${b}: done earlier`);
      continue;
    }
    const j0 = await jobs.start(s, { startFrame: a, endFrame: b });
    let j = j0;
    while (!["completed", "failed", "cancelled", "interrupted"].includes(j.status)) j = await jobs.wait(j0.renderId, 30_000);
    if (j.status !== "completed") throw new Error(`render ${j.status}: ${JSON.stringify(j.error)}`);
    fs.copyFileSync(ws.abs(j.artifact!.relativePath), file + ".tmp");
    fs.renameSync(file + ".tmp", file);
    console.log(`chunk ${a}-${b}: rendered (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
  }
  const list = path.join(parts, "list.txt");
  fs.writeFileSync(list, files.map((f) => `file '${f}'`).join("\n"));
  const cat = spawnSync(ffmpegPath(), ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", path.join(OUT, "city_clash.mp4")], { encoding: "utf8" });
  if (cat.status !== 0) throw new Error(`ffmpeg concat failed: ${cat.stderr.slice(-800)}`);
  console.log(`done: out/city_clash.mp4 (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
