/**
 * First 3D proof, driven only through the engine's workspace API (the same core the MCP server
 * exposes). Nothing is prepared by hand: assets are imported from assets/3d, the scene is built
 * with operations, inspected, corrected from measurements, previewed and rendered to MP4.
 *
 *   npx tsx examples/3d-proof/run.ts [--quality draft|standard|high]
 *
 * Story (5 s): Mika walks into the room holding a mug in the right hand, stops, turns to the
 * camera, waves, smiles and "talks" (mouth morphs) while the camera dollies in. A 2D lower-third
 * title (a normal 2D scene) is composited on top, with music + a chime as audio.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as ops from "../../src/api/operations.js";
import * as ops3d from "../../src/scene3d/operations.js";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager } from "../../src/workspace/workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out");
const quality = (process.argv.includes("--quality") ? process.argv[process.argv.indexOf("--quality") + 1] : "standard") as "draft" | "standard" | "high";

const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail });
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};
const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function wav(seconds: number, fill: (t: number) => number): Buffer {
  const rate = 48000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(fill(i / rate) * 32767))), 44 + i * 2);
  return buf;
}

async function main() {
  fs.rmSync(path.join(OUT, "ws"), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const mgr = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: { models: path.join(ROOT, "assets", "3d") } });
  const ws = mgr.create("proof3d", { name: "3D proof" });
  const T0 = Date.now();

  // ---- 1. assets (reusable ids) ----------------------------------------------------------------
  const imp = async (file: string, assetId: string) =>
    (await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("models", file), origin: { library: "models", path: file } }, { assetId })).asset;
  const mika = await imp("character.glb", "mika");
  await imp("mug.glb", "mug");
  await imp("room.glb", "room");
  const insp = await ws.inspectAsset("mika");
  say(`mika: clips ${mika.model!.clips.map((c) => `${c.name}(${c.duration}s)`).join(", ")}; sockets ${JSON.stringify(mika.model!.sockets)}; morphs ${mika.model!.morphTargets.join(", ")}`);
  check("model thumbnail rendered by the 3D backend", !!insp.view, insp.view);
  const music = wav(5, (t) => {
    const notes = [392, 440, 494, 523.25, 587.33, 523.25, 494, 440];
    const i = Math.floor(t / 0.3125);
    const dt = t - i * 0.3125;
    return 0.18 * Math.exp(-dt * 6) * Math.sin(2 * Math.PI * notes[i % notes.length] * t);
  });
  await ws.importAsset({ kind: "bytes", data: music, filename: "music.wav", origin: { generated: "proof" } }, { assetId: "music" });
  const chime = wav(1.2, (t) => 0.3 * Math.exp(-t * 4) * (Math.sin(2 * Math.PI * 1318.5 * t) + 0.5 * Math.sin(2 * Math.PI * 1975.5 * t)));
  await ws.importAsset({ kind: "bytes", data: chime, filename: "chime.wav", origin: { generated: "proof" } }, { assetId: "chime" });

  // ---- 2. scene ----------------------------------------------------------------------------------
  const fps = 24;
  const dur = 5 * fps;
  const { sceneId } = await ws.createScene({ sceneId: "living_room", kind: "3d", canvas: { width: 1280, height: 720, fps }, duration: dur });
  await ws.mutateScene(sceneId, (d) =>
    ops3d.setSettings3D(d, {
      render: { quality },
      world: { color: "#c9d6e3", strength: 0.6 },
      // deliberately too tight: the measurement step below finds and fixes it
      camera: { position: { x: 0.4, y: 1.5, z: 3.2 }, lookAt: { x: 0, y: 1.1, z: 0 }, fov: 28 },
    }),
  );
  await ws.mutateScene(sceneId, (d) =>
    ops3d.addEntities3D(d, {
      objects: [
        { id: "room", asset: "room" },
        { id: "mika", asset: "mika", clip: "walk", position: { x: -2.2, y: 0, z: 0.4 }, rotation: { x: 0, y: 90, z: 0 } },
        { id: "cup", asset: "mug", attach: { object: "mika", bone: "rightHand" }, position: { x: 0, y: -0.13, z: 0.04 } },
      ],
      lights: [
        { id: "key", type: "sun", intensity: 2.2, rotation: { x: -50, y: -35, z: 0 }, size: 3 },
        { id: "fill", type: "area", intensity: 120, position: { x: 2.5, y: 2.6, z: 3 }, rotation: { x: -35, y: 40, z: 0 }, size: 2.5, shadows: false },
      ],
    }),
  );

  // ---- 3. timeline (the same batch timeline ops as 2D) --------------------------------------------
  const kf = (target: string, property: string, keys: [number, number | string | boolean, string?][]) =>
    keys.map(([frame, value, interpolation]) => ({ type: "keyframe.add", target, property, frame, value, ...(interpolation ? { interpolation } : {}) }));
  await ws.mutateScene(sceneId, (d) =>
    ops.applyTimelineOps(d, [
      ...kf("mika", "position.x", [[0, -2.2], [54, 0]]),
      ...kf("mika", "rotation.y", [[0, 90], [54, 90, "ease-in-out"], [66, 0]]),
      ...kf("mika", "clip", [[0, "walk"], [54, "idle"], [66, "wave"], [102, "idle"]]),
      ...kf("mika", "morph.smile", [[70, 0, "ease-out"], [82, 1], [dur - 1, 1]]),
      ...kf("mika", "morph.mouth_open", [[96, 0], [99, 0.7], [102, 0.1], [105, 0.8], [108, 0.2], [111, 0.6], [114, 0]]),
      ...kf("mika", "morph.blink", [[40, 0], [42, 1], [44, 0], [88, 0], [90, 1], [92, 0]]),
      ...kf("camera", "position.z", [[0, 3.2], [54, 3.2, "ease-in-out"], [dur - 1, 2.4]]),
      ...kf("camera", "lookAt.y", [[0, 1.1], [54, 1.1, "ease-in-out"], [dur - 1, 1.35]]),
    ]),
  );
  await ws.mutateScene(sceneId, (d) =>
    ops.setAudio(d, ws.audioEntries([{ assetId: "music", volume: 0.8 }, { assetId: "chime", startFrame: 66, volume: 0.9 }])),
  );

  // ---- 4. inspect and correct --------------------------------------------------------------------
  const m0 = await ws.measure3D(sceneId, 0, { objects: ["mika", "cup"] });
  const hero0 = m0.objects.find((o) => o.id === "mika")!;
  say(`frame 0 before fix: mika screen ${JSON.stringify(hero0.screen)}`);
  check("measurement detects the character is not fully on screen at frame 0", hero0.screen?.fullyOnScreen === false, { visibleFraction: hero0.screen?.visibleFraction });
  // fix from the numbers: widen the lens until the whole walk path fits (fov from the needed half-width)
  const cam = m0.camera as any;
  const depth = hero0.cameraSpace.depth;
  const needHalfW = Math.abs(hero0.cameraSpace.x) + 0.6;
  const aspect = 1280 / 720;
  const fov = Math.min(70, Math.ceil(((2 * Math.atan(needHalfW / depth / aspect)) * 180) / Math.PI) + 4);
  say(`correction: fov ${cam.fov} -> ${fov} (character ${hero0.cameraSpace.x.toFixed(2)} m left of the view axis at depth ${depth.toFixed(2)} m)`);
  await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: { fov } }));
  // the dolly-in ends close: measure the last frame and back the camera off until the character fits
  for (let attempt = 0; attempt < 6; attempt++) {
    const m = await ws.measure3D(sceneId, dur - 1, { objects: ["mika"] });
    const sc = m.objects[0].screen;
    if (sc?.fullyOnScreen && sc.y + sc.height < 720 - 20) break;
    const endZ = (ws.getSceneDoc(sceneId).animations.find((a: any) => a.target === "camera" && a.property === "position.z").keyframes as any[]).at(-1).value + 0.25;
    say(`end frame: character cropped (screen y ${sc?.y}..${sc && (sc.y + sc.height).toFixed(0)} of 720) -> camera end z ${endZ.toFixed(2)}`);
    await ws.mutateScene(sceneId, (d) => ops.applyTimelineOps(d, [{ type: "keyframe.update", target: "camera", property: "position.z", frame: dur - 1, patch: { value: endZ } }]));
  }
  for (const f of [0, 30, 60, 84, dur - 1]) {
    const m = await ws.measure3D(sceneId, f, { objects: ["mika", "cup"] });
    const h = m.objects.find((o) => o.id === "mika")!;
    const cup = m.objects.find((o) => o.id === "cup")!;
    const hand = h.bones.rightHand;
    check(`frame ${f}: character fully on screen (clip ${h.clips.map((c: any) => c.name).join("+")})`, !!h.screen?.fullyOnScreen, h.screen && { x: h.screen.x, w: h.screen.width });
    check(`frame ${f}: mug stays in the right hand`, dist(cup.world.position, hand.world) < 0.2, { mug: cup.world.position, hand: hand.world });
  }

  // ---- 5. previews -------------------------------------------------------------------------------
  const pv = await ws.renderPreview(sceneId, 84, { debug: true });
  say(`debug preview frame 84: ${pv.relativePath}`);

  // ---- 6. hybrid 2D overlay (a normal 2D scene with a transparent background) --------------------
  const title = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="120">
      <rect x="0" y="0" width="560" height="120" rx="14" fill="#10243d" fill-opacity="0.85"/>
      <rect x="0" y="0" width="12" height="120" rx="4" fill="#ffb020"/>
      <text x="36" y="58" font-family="sans-serif" font-size="40" font-weight="bold" fill="#ffffff">Hi, I'm Mika!</text>
      <text x="36" y="96" font-family="sans-serif" font-size="24" fill="#b9cde6">3D character + 2D overlay, one timeline</text></svg>`),
  ).png().toBuffer();
  await ws.importAsset({ kind: "bytes", data: title, filename: "title.png", origin: { generated: "proof" } }, { assetId: "title" });
  await ws.createScene({ sceneId: "title_overlay", canvas: { width: 1280, height: 720, fps, background: "#00000000" }, duration: dur });
  // 2D layers are positioned by their pivot (the box centre by default)
  await ws.mutateScene("title_overlay", (d) => ops.addLayers(d, [{ id: "banner", asset: "title", x: -320, y: 620 }]));
  await ws.mutateScene("title_overlay", (d) =>
    ops.applyTimelineOps(d, [
      { type: "keyframe.add", target: "banner", property: "x", frame: 66, value: -320, interpolation: "ease-out" },
      { type: "keyframe.add", target: "banner", property: "x", frame: 80, value: 330 },
    ]),
  );
  await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { overlay: { scene: "title_overlay" } }));
  const still = await ws.renderPreview(sceneId, 100, { quality });
  say(`preview frame 100 with overlay: ${still.relativePath}`);

  // ---- 7. video (render job: progress, audio, overlay) ---------------------------------------------
  const jobs = new RenderJobs(ws);
  const job = await jobs.start(sceneId, {});
  let last = -1;
  let j = job;
  const t = Date.now();
  while (!["completed", "failed", "cancelled", "interrupted"].includes(j.status)) {
    j = await jobs.wait(job.renderId, 5000);
    const pct = Math.floor(j.progress * 10);
    if (pct !== last) {
      last = pct;
      say(`render ${j.status} ${(j.progress * 100).toFixed(0)}% (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
  }
  check("video render completed", j.status === "completed", j.error);
  const video = j.artifact!;
  const outMp4 = path.join(OUT, "mika_3d.mp4");
  fs.copyFileSync(ws.abs(video.relativePath), outMp4);
  fs.copyFileSync(ws.abs(pv.relativePath), path.join(OUT, "debug_preview_f84.png"));
  fs.copyFileSync(ws.abs(still.relativePath), path.join(OUT, "preview_f100_overlay.png"));
  if (insp.view) fs.copyFileSync(ws.abs(insp.view.relativePath), path.join(OUT, "mika_thumbnail.jpg"));

  const report = {
    quality,
    seconds: +((Date.now() - T0) / 1000).toFixed(1),
    renderSeconds: j.elapsedSeconds,
    video: { file: path.relative(ROOT, outMp4), bytes: video.bytes, frames: dur, fps, width: 1280, height: 720 },
    checks,
    scene: ws.sceneView(sceneId),
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  say(`done in ${report.seconds} s; ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
