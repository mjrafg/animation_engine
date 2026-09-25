/**
 * Character runtime proof: the SAME high-level schedule drives a prepared 2D character (Pip) and
 * a prepared 3D character (Mika). No keyframe is written here; the runtime compiles everything.
 *
 *   npx tsx examples/characters-proof/run.ts [--skip-3d]
 *
 * Schedule (seconds): idle 0-1.5 | walk right 1.5-4.5 | talk (speech timing + voice audio)
 * from 4.8 | smile 5.3-9.9 | blinks at 6.6 and 7.3 (plus seeded background blinking) | wave
 * 8.5-9.7 | walk back to the start position 10-12.
 * Outputs: out/pip_2d.mp4, out/mika_3d.mp4 (with the voice line), contact sheets, report.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as ops from "../../src/api/operations.js";
import * as ch from "../../src/characters/operations.js";
import { planSpeech } from "../../src/characters/speech.js";
import { blenderInfo } from "../../src/scene3d/blender.js";
import * as ops3d from "../../src/scene3d/operations.js";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager, type VideoWorkspace } from "../../src/workspace/workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out");
const FPS = 24;
const SECONDS = 12.5;
const skip3d = process.argv.includes("--skip-3d") || !blenderInfo().available;
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};

/** A voice-like line (buzzy vowel formants) following the speech timing: stands in for TTS audio. */
function voiceWav(timing: any): Buffer {
  const rate = 48000;
  const dur = timing.duration;
  const n = Math.round(rate * dur);
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
  const spans = planSpeech(timing, dur, 1, 0.03).spans;
  const formant: Record<string, [number, number]> = { AI: [800, 1200], E: [500, 1900], O: [500, 900], U: [320, 800], MBP: [250, 700], FV: [300, 1500], L: [400, 1300], rest: [0, 0] };
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const s = spans.find((x) => t >= x.start && t < x.end);
    let v = 0;
    if (s && s.viseme !== "rest") {
      const f0 = 150 + 25 * Math.sin(t * 3.1);
      phase += (2 * Math.PI * f0) / rate;
      const env = Math.min(1, (t - s.start) / 0.02, (s.end - t) / 0.02);
      const [a, b] = formant[s.viseme];
      for (let h = 1; h <= 20; h++) {
        const fh = f0 * h;
        const g = Math.exp(-(((fh - a) / 180) ** 2)) + 0.6 * Math.exp(-(((fh - b) / 250) ** 2));
        v += (g * Math.sin(phase * h)) / h;
      }
      v *= 0.5 * env;
    }
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

const SCHEDULE = (talkSpeech: string, walkDir1: string, home: Record<string, number>) => [
  { type: "add", action: { id: "idle1", action: "idle", start: 0, duration: 1.5 } },
  { type: "add", action: { id: "walk1", action: "walk", start: 1.5, duration: 3, direction: walkDir1 } },
  { type: "add", action: { id: "talk1", action: "talk", start: 4.8, speech: talkSpeech } },
  { type: "add", action: { id: "smile1", action: "smile", start: 5.3, duration: 4.6 } },
  { type: "add", action: { id: "blink1", action: "blink", start: 6.6, duration: 1, count: 2 } },
  { type: "add", action: { id: "wave1", action: "wave", start: 8.5, duration: 1.2 } },
  { type: "add", action: { id: "walk2", action: "walk", start: 10, duration: 2, to: home } }, // walk back to where it started
];

async function renderJob(ws: VideoWorkspace, sceneId: string, label: string) {
  const jobs = new RenderJobs(ws);
  const j0 = await jobs.start(sceneId, {});
  let j = j0;
  while (!["completed", "failed", "cancelled", "interrupted"].includes(j.status)) j = await jobs.wait(j0.renderId, 30_000);
  check(`${label}: video rendered`, j.status === "completed", j.error ?? { seconds: j.elapsedSeconds });
  return j.artifact!;
}

async function sheet(ws: VideoWorkspace, sceneId: string, frames: number[], out: string, width: number) {
  const tiles = [];
  for (const f of frames) {
    const a = await ws.renderPreview(sceneId, f);
    tiles.push(await sharp(ws.abs(a.relativePath)).resize(width).png().toBuffer());
  }
  const h = (await sharp(tiles[0]).metadata()).height!;
  await sharp({ create: { width: width * 2, height: h * Math.ceil(frames.length / 2), channels: 3, background: "#000" } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % 2) * width, top: Math.floor(i / 2) * h })))
    .jpeg({ quality: 82 })
    .toFile(out);
}

async function main() {
  fs.rmSync(path.join(OUT, "ws"), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const mgr = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: { characters: path.join(ROOT, "assets", "characters"), models: path.join(ROOT, "assets", "3d") } });
  const ws = mgr.create("characters");
  const t0 = Date.now();

  // ---- prepare once ---------------------------------------------------------------------------
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  if (!skip3d) await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"));
  const hello = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "speech", "hello_pip.json"), "utf8"));
  await ws.importAsset({ kind: "bytes", data: voiceWav(hello), filename: "hello_voice.wav", origin: { synthesized: "from speech timing" } }, { assetId: "hello_voice" });
  ws.saveSpeechTiming("hello", { ...hello, audio: "hello_voice" });
  await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "characters", "props", "mug.png"), origin: {} }, { assetId: "mug" });
  const ctx = ws.characterContext();

  // ---- 2D -------------------------------------------------------------------------------------
  const s2 = "pip_2d";
  await ws.createScene({ sceneId: s2, canvas: { width: 1280, height: 720, fps: FPS, background: "#cfe8f7" }, duration: Math.round(SECONDS * FPS) });
  await ws.mutateScene(s2, (d) =>
    ops.addLayers(d, [
      { id: "sun", fill: "#ffe38a", x: 1120, y: 110, width: 90, height: 90, z: 0 },
      { id: "hill", fill: "#a9d88f", x: 640, y: 600, width: 1400, height: 140, z: 1 },
      { id: "ground", fill: "#7fbf6a", x: 640, y: 690, width: 1280, height: 90, z: 2 },
    ]),
  );
  await ws.mutateScene(s2, (d) => ch.addCharacter(d, { id: "pip", character: "pip", x: 220, y: 660, scale: 1.3, props: [{ id: "mug", asset: "mug", socket: "rightHand", y: 4 }] }, ctx));
  const r2 = await ws.mutateScene(s2, (d) => ch.applyCharacterActions(d, "pip", SCHEDULE("hello", "right", { x: 220 }), ctx));
  const doc2 = ws.getSceneDoc(s2);
  console.log(`2D: ${doc2.animations.filter((a: any) => a.owner).length} generated tracks from ${doc2.characters[0].actions.length} actions`);
  const x = async (sec: number) => (await ws.measureLayout(s2, Math.round(sec * FPS), ["pip"])).layers[0].worldPivot.x;
  check("2D: idle in place at start", Math.abs((await x(1)) - 220) < 0.5);
  check("2D: walked right 3 s", Math.abs((await x(4.6)) - (220 + 3 * 200 * 1.3)) < 0.5, { x: await x(4.6) });
  check("2D: walked back left", Math.abs((await x(12.2)) - 220) < 0.5, { x: await x(12.2) });
  check("2D: no warnings", r2.warnings.length === 0, r2.warnings);
  const tl2 = ch.characterTimeline(doc2, ctx)[0];
  check("2D: speech from character alignment with audio", (tl2.actions.find((a: any) => a.id === "talk1") as any).resolved.speechSource === "characters" && doc2.audio.some((a: any) => a.owner === "pip"));
  await sheet(ws, s2, [18, 72, 120, 150, 165, 180, 222, 270], path.join(OUT, "pip_2d_sheet.jpg"), 640);
  const v2 = await renderJob(ws, s2, "2D");
  fs.copyFileSync(ws.abs(v2.relativePath), path.join(OUT, "pip_2d.mp4"));

  // ---- 3D -------------------------------------------------------------------------------------
  let v3: any = null;
  if (!skip3d) {
    await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "room.glb"), origin: {} }, { assetId: "room" });
    await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "mug.glb"), origin: {} }, { assetId: "mug3d" });
    const s3 = "mika_3d";
    await ws.createScene({ sceneId: s3, kind: "3d", canvas: { width: 960, height: 540, fps: FPS }, duration: Math.round(SECONDS * FPS) });
    await ws.mutateScene(s3, (d) =>
      ops3d.addEntities3D(d, {
        objects: [{ id: "room", asset: "room" }],
        lights: [
          { id: "key", type: "sun", intensity: 2.2, rotation: { x: -50, y: -30, z: 0 }, size: 3 },
          { id: "fill", type: "area", intensity: 120, position: { x: 2.5, y: 2.6, z: 3 }, rotation: { x: -35, y: 40, z: 0 }, size: 2.5, shadows: false },
        ],
      }),
    );
    await ws.mutateScene(s3, (d) => ops3d.setSettings3D(d, { camera: { position: { x: 0, y: 1.5, z: 5.2 }, lookAt: { x: 0, y: 1.05, z: 0 }, fov: 52 }, world: { color: "#c9d6e3", strength: 0.6 }, render: { quality: "draft" } }));
    await ws.mutateScene(s3, (d) =>
      ch.addCharacter(d, { id: "mika", character: "mika", position: { x: -2, y: 0, z: 0.4 }, props: [{ id: "mug", asset: "mug3d", socket: "leftHand", position: { y: -0.1, z: 0.04 }, follow: "position" }] }, ctx),
    );
    // same schedule; 3D adds a turn to the camera before talking (a 2D side-view character has no front view)
    await ws.mutateScene(s3, (d) => ch.applyCharacterActions(d, "mika", [...SCHEDULE("hello", "right", { x: -2, z: 0.4 }), { type: "add", action: { id: "turn1", action: "turn", start: 4.55, direction: "camera" } }], ctx));
    const m = await ws.measure3D(s3, Math.round(7 * FPS), { objects: ["mika", "mika.mug"] });
    const hand = m.objects.find((o) => o.id === "mika")!.bones.leftHand.world;
    const mug = m.objects.find((o) => o.id === "mika.mug")!.world.position;
    const gap = Math.hypot(mug.x - hand.x, mug.y - hand.y, mug.z - hand.z);
    check("3D: mug follows the left hand (at its 11 cm grip offset)", Math.abs(gap - Math.hypot(0.1, 0.04)) < 0.01, { gap: +gap.toFixed(3) });
    check("3D: faces the camera while talking", Math.abs(m.objects.find((o) => o.id === "mika")!.world.rotation.y) < 1, m.objects[0].world.rotation);
    await sheet(ws, s3, [18, 72, 120, 150, 165, 215, 245, 285], path.join(OUT, "mika_3d_sheet.jpg"), 480);
    v3 = await renderJob(ws, s3, "3D");
    fs.copyFileSync(ws.abs(v3.relativePath), path.join(OUT, "mika_3d.mp4"));
  }

  const report = {
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
    schedule: SCHEDULE("hello", "right", { x: 220 }).map((o) => o.action),
    videos: { pip_2d: { bytes: v2.bytes, durationSeconds: v2.durationSeconds }, ...(v3 ? { mika_3d: { bytes: v3.bytes, durationSeconds: v3.durationSeconds } } : {}) },
    checks,
    timeline2d: tl2,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`done in ${report.seconds} s; ${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
