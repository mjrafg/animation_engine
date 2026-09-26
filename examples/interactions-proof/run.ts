/**
 * Multi-character interaction proof. Everything is driven by high-level character actions and
 * interactions; no keyframe is written here (the runtime compiles all of it).
 *
 *   npx tsx examples/interactions-proof/run.ts [--skip-3d] [--skip-video]
 *
 * Outputs (out/):
 *  - conversation_3d.mp4  the required conversation scene (Mika + smaller Mika):
 *      0-3 s A walks to B | 3-6 A talks and smiles, B blinks | 6-9 B talks | 9-11 both talk |
 *      11-14 handshake | 14-16 they separate
 *  - interactions_3d.mp4  two differently sized 3D characters: independent movement, talk and
 *      react, handshake, high five, hug, handing over a mug, simultaneous expressions, separation
 *  - interactions_2d.mp4  the same kind of story with two 2D characters (Pip, different sizes)
 *  - *_sheet.jpg contact sheets, report.json with every measured check
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as ops from "../../src/api/operations.js";
import { interactionTimeline } from "../../src/characters/interactions.js";
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
const F = (s: number) => Math.round(s * FPS);
const skip3d = process.argv.includes("--skip-3d") || !blenderInfo().available;
const skipVideo = process.argv.includes("--skip-video");
const checks: { group: string; name: string; ok: boolean; detail?: unknown }[] = [];
let group = "";
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ group, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${group}] ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ---- speech lines (word timing + a synthetic voice standing in for TTS audio) -------------------

function line(text: string, seconds: number) {
  const words = text.split(" ");
  const step = seconds / words.length;
  return { text, duration: seconds, words: words.map((w, i) => ({ word: w, start: r4(i * step + 0.04), end: r4((i + 1) * step - 0.05) })) };
}

function voiceWav(timing: any, pitch: number): Buffer {
  const rate = 48000;
  const n = Math.round(rate * timing.duration);
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
  const spans = planSpeech(timing, timing.duration, 1, 0.03).spans;
  const formant: Record<string, [number, number]> = { AI: [800, 1200], E: [500, 1900], O: [500, 900], U: [320, 800], MBP: [250, 700], FV: [300, 1500], L: [400, 1300], rest: [0, 0] };
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const s = spans.find((x) => t >= x.start && t < x.end);
    let v = 0;
    if (s && s.viseme !== "rest") {
      const f0 = pitch + 0.15 * pitch * Math.sin(t * 3.1);
      phase += (2 * Math.PI * f0) / rate;
      const env = Math.min(1, (t - s.start) / 0.02, (s.end - t) / 0.02);
      const [a, b] = formant[s.viseme];
      for (let h = 1; h <= 20; h++) {
        const fh = f0 * h;
        const g = Math.exp(-(((fh - a) / 180) ** 2)) + 0.6 * Math.exp(-(((fh - b) / 250) ** 2));
        v += (g * Math.sin(phase * h)) / h;
      }
      v *= 0.45 * env;
    }
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return buf;
}

const LINES: Record<string, [string, number, number]> = {
  a_hi: ["Hi there! I finally found you. How are you doing today?", 2.8, 150],
  b_hi: ["Oh hello! I am great, thanks. It is good to see you again.", 2.8, 230],
  a_both: ["So shall we go now?", 1.9, 150],
  b_both: ["Yes, let us go.", 1.9, 230],
  a_gift: ["I brought you something.", 1.8, 150],
  b_thanks: ["A mug! Thank you so much!", 2, 230],
};

// ---- helpers ------------------------------------------------------------------------------------

/** Value of a numeric track (or static property) at a frame, read from the canonical timeline. */
function trackAt(doc: any, target: string, prop: string, frame: number, fallback = 0): number {
  const tr = doc.animations.find((a: any) => a.target === target && a.property === prop);
  if (!tr) return fallback;
  const ks = tr.keyframes;
  if (frame <= ks[0].frame) return ks[0].value;
  for (let i = 0; i + 1 < ks.length; i++) {
    if (frame >= ks[i].frame && frame <= ks[i + 1].frame) {
      if (ks[i].interpolation === "step") return ks[i].value;
      const t = (frame - ks[i].frame) / (ks[i + 1].frame - ks[i].frame);
      return ks[i].value + (ks[i + 1].value - ks[i].value) * t;
    }
  }
  return ks[ks.length - 1].value;
}
const maxOver = (doc: any, target: string, prop: string, a: number, b: number) => {
  let m = 0;
  for (let f = F(a); f < F(b); f++) m = Math.max(m, trackAt(doc, target, prop, f));
  return r4(m);
};

async function renderJob(ws: VideoWorkspace, sceneId: string, label: string) {
  if (skipVideo) return null;
  const jobs = new RenderJobs(ws);
  const j0 = await jobs.start(sceneId, {});
  let j = j0;
  while (!["completed", "failed", "cancelled", "interrupted"].includes(j.status)) j = await jobs.wait(j0.renderId, 30_000);
  check(`${label}: video rendered`, j.status === "completed", j.error ?? { seconds: j.elapsedSeconds });
  if (j.artifact) fs.copyFileSync(ws.abs(j.artifact.relativePath), path.join(OUT, `${label}.mp4`));
  return j.artifact ? { bytes: j.artifact.bytes, durationSeconds: j.artifact.durationSeconds } : null;
}

async function sheet(ws: VideoWorkspace, sceneId: string, frames: number[], out: string, width: number) {
  const tiles = [];
  for (const f of frames) {
    const a = await ws.renderPreview(sceneId, f);
    const img = sharp(ws.abs(a.relativePath)).resize(width);
    const label = Buffer.from(`<svg width="${width}" height="28"><rect width="${width}" height="28" fill="black" opacity="0.55"/><text x="8" y="20" font-family="sans-serif" font-size="18" fill="white">${(f / FPS).toFixed(2)} s</text></svg>`);
    tiles.push(await img.composite([{ input: label, top: 0, left: 0 }]).png().toBuffer());
  }
  const h = (await sharp(tiles[0]).metadata()).height!;
  const cols = 3;
  await sharp({ create: { width: width * cols, height: h * Math.ceil(frames.length / cols), channels: 3, background: "#000" } })
    .composite(tiles.map((t, i) => ({ input: t, left: (i % cols) * width, top: Math.floor(i / cols) * h })))
    .jpeg({ quality: 82 })
    .toFile(out);
}

const gripOf = (o: any, grip: number) => {
  const h = o.bones.rightHand ?? o.bones[Object.keys(o.bones)[0]];
  const t = h.tail.world;
  const len = Math.hypot(t.x - h.world.x, t.y - h.world.y, t.z - h.world.z) || 1;
  return { x: h.world.x + ((t.x - h.world.x) / len) * grip, y: h.world.y + ((t.y - h.world.y) / len) * grip, z: h.world.z + ((t.z - h.world.z) / len) * grip };
};
const d3 = (p: any, q: any) => Math.hypot(p.x - q.x, p.y - q.y, (p.z ?? 0) - (q.z ?? 0));

/** Measured distance between the two actors' hands that share a target, at the middle of the contact. */
async function measuredContact(ws: VideoWorkspace, sceneId: string, ixId: string) {
  const tl: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
  const ix = tl.interactions.find((x: any) => x.id === ixId);
  const c = ix.contacts[0];
  const frame = Math.round(((c.contactStart + c.contactEnd) / 2) * FPS);
  const m: any = await ws.inspectInteractions(sceneId, frame);
  const hands = m.measured.hands.filter((h: any) => h.ix === ixId);
  return { frame, hands, worst: Math.max(...hands.map((h: any) => h.distanceToPartnerHand ?? h.distanceToTarget ?? Infinity)) };
}

async function stage3d(ws: VideoWorkspace, sceneId: string, seconds: number, camera: Record<string, unknown>) {
  await ws.createScene({ sceneId, kind: "3d", canvas: { width: 960, height: 540, fps: FPS }, duration: Math.round(seconds * FPS) });
  await ws.mutateScene(sceneId, (d) =>
    ops3d.addEntities3D(d, {
      objects: [{ id: "room", asset: "room" }],
      lights: [
        { id: "key", type: "sun", intensity: 2.2, rotation: { x: -50, y: -30, z: 0 }, size: 3 },
        { id: "fill", type: "area", intensity: 120, position: { x: 2.5, y: 2.6, z: 3 }, rotation: { x: -35, y: 40, z: 0 }, size: 2.5, shadows: false },
      ],
    }),
  );
  await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera, world: { color: "#c9d6e3", strength: 0.6 }, render: { quality: "draft" } }));
}

// ================================================================================================

async function main() {
  fs.rmSync(path.join(OUT, "ws"), { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const libs = { characters: path.join(ROOT, "assets", "characters"), interactions: path.join(ROOT, "assets", "interactions") };
  const mgr = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: libs });
  const ws = mgr.create("interactions");
  const t0 = Date.now();
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "characters", "props", "mug.png"), origin: {} }, { assetId: "mug" });
  for (const [id, [text, dur, pitch]] of Object.entries(LINES)) {
    const t = line(text, dur);
    await ws.importAsset({ kind: "bytes", data: voiceWav(t, pitch), filename: `${id}.wav`, origin: { synthesized: "from speech timing" } }, { assetId: `voice_${id}` });
    ws.saveSpeechTiming(id, { ...t, audio: `voice_${id}` });
  }
  const ctx = () => ws.characterContext();
  const act = (s: string, who: string, list: Record<string, unknown>[]) => ws.mutateScene(s, (d) => ch.applyCharacterActions(d, who, list.map((action) => ({ type: "add", action })), ctx()));
  const interact = (s: string, list: Record<string, unknown>[]) => ws.mutateScene(s, (d) => ch.applyInteractionOps(d, list.map((interaction) => ({ type: "add", interaction })), ctx()));
  const report: Record<string, unknown> = {};

  // ---- 3D ---------------------------------------------------------------------------------------
  if (!skip3d) {
    await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"));
    await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "room.glb"), origin: {} }, { assetId: "room" });
    await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "mug.glb"), origin: {} }, { assetId: "mug3d" });

    // ---- conversation scene (exact schedule from the brief) -------------------------------------
    group = "conversation_3d";
    const cv = "conversation_3d";
    await stage3d(ws, cv, 16, { position: { x: -0.5, y: 1.55, z: 4.1 }, lookAt: { x: -0.4, y: 1.05, z: 0 }, fov: 50 });
    await ws.mutateScene(cv, (d) => ch.addCharacter(d, { id: "a", character: "mika", position: { x: -2.8, y: 0, z: 0.2 }, facing: "right" }, ctx()));
    await ws.mutateScene(cv, (d) => ch.addCharacter(d, { id: "b", character: "mika", position: { x: 0.9, y: 0, z: 0 }, facing: "left", scale: 0.88 }, ctx()));
    await act(cv, "a", [
      { id: "walk_to_b", action: "walk", start: 0, duration: 3, to: { x: 0.2, z: 0 } },
      { id: "talk1", action: "talk", start: 3, duration: 3, speech: "a_hi" },
      { id: "smile1", action: "smile", start: 3, duration: 3 },
      { id: "talk_both", action: "talk", start: 9, duration: 2, speech: "a_both" },
      { id: "walk_away", action: "walk", start: 14, duration: 2, to: { x: -1.6, z: 0.6 } },
    ]);
    await act(cv, "b", [
      { id: "blink1", action: "blink", start: 3.4, duration: 2.2, count: 2 },
      { id: "talk1", action: "talk", start: 6, duration: 3, speech: "b_hi" },
      { id: "smile_b", action: "smile", start: 7.5, duration: 3.5 },
      { id: "talk_both", action: "talk", start: 9, duration: 2, speech: "b_both" },
      { id: "turn_cam", action: "turn", start: 14.1, direction: "camera" },
    ]);
    const cr = await interact(cv, [{ id: "shake", interaction: "handshake", actors: ["a", "b"], start: 11, duration: 3 }]);
    const cdoc = ws.getSceneDoc(cv);
    check("no interaction warnings", !cr.warnings.some((w) => w.code.startsWith("INTERACTION")), cr.warnings);
    const mouth = (who: string, a: number, b: number) => maxOver(cdoc, who, "morph.mouth_open", a, b);
    const seg = {
      "3-6 A talks": { a: mouth("a", 3.1, 5.9), b: mouth("b", 3.1, 5.9) },
      "6-9 B talks": { a: mouth("a", 6.1, 8.9), b: mouth("b", 6.1, 8.9) },
      "9-11 both talk": { a: mouth("a", 9.1, 10.9), b: mouth("b", 9.1, 10.9) },
    };
    check("3-6: only A's mouth moves", seg["3-6 A talks"].a > 0.3 && seg["3-6 A talks"].b === 0, seg["3-6 A talks"]);
    check("6-9: only B's mouth moves", seg["6-9 B talks"].b > 0.3 && seg["6-9 B talks"].a === 0, seg["6-9 B talks"]);
    check("9-11: both mouths move", seg["9-11 both talk"].a > 0.3 && seg["9-11 both talk"].b > 0.3, seg["9-11 both talk"]);
    check("3-6: A smiles, B does not", maxOver(cdoc, "a", "morph.smile", 3.5, 5.5) > 0.5 && maxOver(cdoc, "b", "morph.smile", 3.5, 5.5) === 0, { a: maxOver(cdoc, "a", "morph.smile", 3.5, 5.5), b: maxOver(cdoc, "b", "morph.smile", 3.5, 5.5) });
    check("3-6: B blinks (scheduled)", maxOver(cdoc, "b", "morph.blink", 3.4, 5.6) > 0.9, { b: maxOver(cdoc, "b", "morph.blink", 3.4, 5.6) });
    check(
      "each voice line is its speaker's own audio",
      JSON.stringify(cdoc.audio.map((x: any) => [x.owner, +(x.startFrame / FPS).toFixed(2)]).sort()) === JSON.stringify([["a", 3], ["a", 9], ["b", 6], ["b", 9]]),
      cdoc.audio.map((x: any) => [x.owner, x.startFrame / FPS]),
    );
    const pos = async (f: number) => {
      const m: any = await ws.measure3D(cv, f, { objects: ["a", "b"] });
      return Object.fromEntries(m.objects.map((o: any) => [o.id, o.world.position]));
    };
    const p3 = await pos(F(3));
    check("0-3: A walked up to B", Math.abs(p3.a.x - 0.2) < 0.02 && d3(p3.a, p3.b) < 1, { a: p3.a, distance: r4(d3(p3.a, p3.b)) });
    const hs = await measuredContact(ws, cv, "shake");
    check("11-14: handshake, measured palm-to-palm distance < 1 cm", hs.worst < 0.01, { frame: hs.frame, metres: hs.worst });
    const p13 = await pos(F(13.5));
    const p16 = await pos(F(15.95));
    check("14-16: they separate", d3(p16.a, p16.b) > d3(p13.a, p13.b) + 0.8, { at13_5: r4(d3(p13.a, p13.b)), at16: r4(d3(p16.a, p16.b)) });
    await sheet(ws, cv, [F(0.5), F(2.5), F(4.5), F(7.5), F(10), F(11.8), F(12.4), F(13.6), F(15.6)], path.join(OUT, "conversation_3d_sheet.jpg"), 480);
    const cvVideo = await renderJob(ws, cv, "conversation_3d");
    report.conversation_3d = { mouthOpenMax: seg, handshake: hs, video: cvVideo, interactions: (interactionTimeline(cdoc, ctx()) as any).interactions };

    // ---- showcase: different sizes, many interactions --------------------------------------------
    group = "interactions_3d";
    const s3 = "interactions_3d";
    await stage3d(ws, s3, 22, { position: { x: 0.2, y: 1.6, z: 4.5 }, lookAt: { x: 0.0, y: 1.05, z: 0 }, fov: 52 });
    await ws.mutateScene(s3, (d) =>
      ch.addCharacter(d, { id: "a", character: "mika", position: { x: -3, y: 0, z: 0.5 }, facing: "right", props: [{ id: "mug", asset: "mug3d", socket: "rightHand", follow: "position", position: { y: -0.075 }, visibleFrom: 14 }] }, ctx()),
    );
    await ws.mutateScene(s3, (d) => ch.addCharacter(d, { id: "b", character: "mika", position: { x: 2.6, y: 0, z: -0.3 }, facing: "left", scale: 0.8 }, ctx()));
    await act(s3, "a", [
      { action: "walk", start: 0, duration: 2.2, to: { x: -0.5, z: 0.2 } },
      { action: "talk", start: 2.4, duration: 1.8, speech: "a_gift" },
      { action: "smile", start: 2.4, duration: 5 },
      { action: "smile", start: 18, duration: 2 },
      { action: "talk", start: 14, duration: 1.8, speech: "a_gift" },
      { action: "walk", start: 19.6, duration: 2.2, to: { x: -2.6, z: 0.8 } },
    ]);
    await act(s3, "b", [
      { action: "walk", start: 0, duration: 2.2, to: { x: 0.6, z: 0 } },
      { action: "surprised", start: 2.5, duration: 1.4 },
      { action: "blink", start: 3, count: 2, duration: 1 },
      { action: "talk", start: 17.6, duration: 2, speech: "b_thanks" },
      { action: "smile", start: 17.6, duration: 2.4 },
      { action: "walk", start: 19.8, duration: 2, to: { x: 2.4, z: 0.4 } },
    ]);
    const sr = await interact(s3, [
      { id: "shake", interaction: "handshake", actors: ["a", "b"], start: 4.2, duration: 3 },
      { id: "five", interaction: "high_five", actors: ["b", "a"], start: 7.4, duration: 2 },
      { id: "hug", interaction: "hug", actors: ["a", "b"], start: 9.6, duration: 3.8 },
      { id: "gift", interaction: "give_object", actors: ["a", "b"], start: 14.2, duration: 3.2, params: { object: "mug" } },
    ]);
    const sdoc = ws.getSceneDoc(s3);
    check("no interaction warnings (different sizes adapt)", !sr.warnings.some((w) => w.code.startsWith("INTERACTION")), sr.warnings);
    const shake = await measuredContact(ws, s3, "shake");
    check("handshake (scale 1 vs 0.8): palms meet < 1 cm", shake.worst < 0.01, { metres: shake.worst });
    const five = await measuredContact(ws, s3, "five");
    check("high five: hands meet < 1 cm", five.worst < 0.01, { metres: five.worst });
    const hug = await measuredContact(ws, s3, "hug");
    check("hug: hands on the partner's back within 3 cm", hug.worst < 0.03, { metres: hug.worst });
    const tl: any = interactionTimeline(sdoc, ctx());
    const tr = tl.interactions.find((x: any) => x.id === "gift").transfer;
    const mugs = async (f: number) => {
      const m: any = await ws.measure3D(s3, f, { objects: ["a", "b", "a.mug", "b.mug"] });
      return Object.fromEntries(m.objects.map((o: any) => [o.id, o]));
    };
    const before = await mugs(tr.frame - 1);
    const at = await mugs(tr.frame);
    const jump = d3(at["a.mug"].world.position, at["b.mug"].world.position);
    check("transfer: owner switches once (a.mug hidden, b.mug shown at the same frame)", !at["a.mug"].visible && at["b.mug"].visible && before["a.mug"].visible && !before["b.mug"].visible, { frame: tr.frame });
    check("transfer: the mug does not jump (< 1 cm)", jump < 0.01, { metres: r4(jump) });
    const follow = async (f: number, who: string) => {
      const m = await mugs(f);
      return r4(d3(m[`${who}.mug`].world.position, m[who].bones.rightHand.world));
    };
    const fa = [await follow(F(14.5), "a"), await follow(tr.frame - 2, "a")];
    const fb = [await follow(tr.frame + 2, "b"), await follow(F(19), "b"), await follow(F(21.5), "b")];
    check("before: the mug follows A's hand", Math.abs(fa[0] - fa[1]) < 0.005, fa);
    check("after: the mug follows B's hand (walking away)", Math.max(...fb) - Math.min(...fb) < 0.005, fb);
    check("simultaneous faces at 18.5 s: A smiles while B talks and smiles", trackAt(sdoc, "a", "morph.smile", F(18.5)) > 0.5 && trackAt(sdoc, "b", "morph.smile", F(18.5)) > 0.5 && maxOver(sdoc, "b", "morph.mouth_open", 18, 19) > 0.3 && maxOver(sdoc, "a", "morph.mouth_open", 18, 19) === 0);

    // save / reload / re-render: another manager on the same directory sees the same document
    const saved = JSON.stringify(ws.getSceneDoc(s3));
    const ws2 = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: libs }).open("interactions");
    await ws2.mutateScene(s3, (d) => ch.recompileCharacters(d, ws2.characterContext()));
    check("save/reload: recompiling the reloaded scene reproduces it byte for byte", JSON.stringify(ws2.getSceneDoc(s3)) === saved);
    const m2: any = await ws2.measure3D(s3, tr.frame + 12, { objects: ["b.mug"] });
    const m1: any = await ws.measure3D(s3, tr.frame + 12, { objects: ["b.mug"] });
    check("save/reload: the transferred mug is in the same place after reload", d3(m1.objects[0].world.position, m2.objects[0].world.position) < 1e-4);

    await sheet(ws, s3, [F(1), F(3), F(5.8), F(8.6), F(11.6), F(15.2), F(16.2), F(18.5), F(21)], path.join(OUT, "interactions_3d_sheet.jpg"), 480);
    const v3 = await renderJob(ws, s3, "interactions_3d");
    report.interactions_3d = { contacts: { shake, five, hug }, transfer: { ...tr, jumpMetres: r4(jump), followA: fa, followB: fb }, video: v3, interactions: tl.interactions, objects: tl.objects };

    // ---- different sizes (3D) ---------------------------------------------------------------------
    group = "sizes_3d";
    const sizes: unknown[] = [];
    for (const scale of [0.65, 0.8, 1.2]) {
      const s = `size3d_${String(scale).replace(".", "_")}`;
      await stage3d(ws, s, 4, { position: { x: 0.3, y: 1.4, z: 4 }, lookAt: { x: 0.3, y: 1, z: 0 } });
      await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "a", character: "mika", position: { x: -0.4, y: 0, z: 0 }, facing: "right" }, ctx()));
      await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "b", character: "mika", position: { x: 0.9, y: 0, z: 0 }, facing: "left", scale }, ctx()));
      const r = await interact(s, [{ id: "shake", interaction: "handshake", actors: ["a", "b"], start: 0.3, duration: 3 }]);
      const c = await measuredContact(ws, s, "shake");
      const ix: any = (interactionTimeline(ws.getSceneDoc(s), ctx()) as any).interactions[0];
      sizes.push({ scale, distance: ix.alignment.distance, contactHeight: ix.contacts[0].targetAtContact.y, measuredMetres: c.worst, warnings: r.warnings.map((w) => w.code) });
      check(`handshake with a partner at scale ${scale}: palms meet < 1 cm`, c.worst < 0.01, { metres: c.worst, distance: ix.alignment.distance });
    }
    report.sizes_3d = sizes;
  }

  // ---- 2D ---------------------------------------------------------------------------------------
  group = "interactions_2d";
  const s2 = "interactions_2d";
  await ws.createScene({ sceneId: s2, canvas: { width: 1280, height: 720, fps: FPS, background: "#cfe8f7" }, duration: 20 * FPS });
  await ws.mutateScene(s2, (d) =>
    ops.addLayers(d, [
      { id: "sun", fill: "#ffe38a", x: 1120, y: 110, width: 90, height: 90, z: 0 },
      { id: "hill", fill: "#a9d88f", x: 640, y: 600, width: 1400, height: 140, z: 1 },
      { id: "ground", fill: "#7fbf6a", x: 640, y: 690, width: 1280, height: 90, z: 2 },
    ]),
  );
  await ws.mutateScene(s2, (d) => ch.addCharacter(d, { id: "a", character: "pip", x: 170, y: 660, scale: 1.1, props: [{ id: "mug", asset: "mug", socket: "rightHand", scale: 0.55, visibleFrom: 10.6 }] }, ctx()));
  await ws.mutateScene(s2, (d) => ch.addCharacter(d, { id: "b", character: "pip", x: 1050, y: 660, scale: 0.85, facing: "left", z: 12 }, ctx()));
  await act(s2, "a", [
    { action: "walk", start: 0, duration: 2.5, to: { x: 520 } },
    { action: "talk", start: 2.6, duration: 2.6, speech: "a_hi" },
    { action: "smile", start: 2.6, duration: 2.6 },
    { action: "talk", start: 10.8, duration: 1.8, speech: "a_gift" },
    { action: "walk", start: 17.6, duration: 2.2, direction: "left" },
  ]);
  await act(s2, "b", [
    { action: "walk", start: 0.3, duration: 2, to: { x: 820 } },
    { action: "blink", start: 3, count: 2, duration: 1.2 },
    { action: "talk", start: 5.4, duration: 1.8, speech: "b_thanks" },
    { action: "surprised", start: 5.4, duration: 1.2 },
    { action: "smile", start: 13.2, duration: 3 },
    { action: "walk", start: 17.8, duration: 2, direction: "right" },
  ]);
  const r2 = await interact(s2, [
    { id: "shake", interaction: "handshake", actors: ["a", "b"], start: 6.2, duration: 2.8 },
    { id: "five", interaction: "high_five", actors: ["b", "a"], start: 9.1, duration: 1.5 },
    { id: "gift", interaction: "give_object", actors: ["a", "b"], start: 10.8, duration: 3, params: { object: "mug" } },
    { id: "hug", interaction: "hug", actors: ["b", "a"], start: 14.2, duration: 3.2 },
  ]);
  check("no interaction warnings", !r2.warnings.some((w) => w.code.startsWith("INTERACTION")), r2.warnings);
  const c2: Record<string, unknown> = {};
  for (const id of ["shake", "gift", "five"]) {
    const c = await measuredContact(ws, s2, id);
    c2[id] = c;
    check(`${id}: measured grip-to-grip distance < 1 px`, c.worst < 1, { px: c.worst });
  }
  const hug2 = await measuredContact(ws, s2, "hug");
  c2.hug = hug2;
  check("hug: hands at the partner's back (< 2 px)", hug2.worst < 2, { px: hug2.worst });
  const tl2: any = interactionTimeline(ws.getSceneDoc(s2), ctx());
  const t2 = tl2.interactions.find((x: any) => x.id === "gift").transfer;
  const lay = async (f: number, ids: string[]) => Object.fromEntries((await ws.measureLayout(s2, f, ids)).layers.map((x) => [x.id, x]));
  const m2 = await lay(t2.frame, ["a.mug", "b.mug"]);
  const jump2 = Math.max(...m2["a.mug"].worldCorners.map((p, i) => Math.hypot(p.x - m2["b.mug"].worldCorners[i].x, p.y - m2["b.mug"].worldCorners[i].y)));
  check("transfer: the mug does not jump (corners < 0.5 px)", jump2 < 0.5, { px: r4(jump2) });
  const doc2 = ws.getSceneDoc(s2);
  const visKeys = (id: string) => doc2.animations.find((x: any) => x.target === id && x.property === "visible").keyframes.map((k: any) => [k.frame, k.value]);
  check("transfer: exactly one owner change", JSON.stringify(visKeys("a.mug")) === JSON.stringify([[0, false], [F(10.6), true], [t2.frame, false]]) && JSON.stringify(visKeys("b.mug")) === JSON.stringify([[0, false], [t2.frame, true]]), { a: visKeys("a.mug"), b: visKeys("b.mug") });
  const end = await lay(F(19.9), ["a", "b"]);
  check("they separate at the end", Math.abs(end.a.worldPivot.x - end.b.worldPivot.x) > 500, { a: end.a.worldPivot.x, b: end.b.worldPivot.x });
  await sheet(ws, s2, [F(1.2), F(3.5), F(7.3), F(10.1), F(12.6), F(13.0), F(15.6), F(17.2), F(19.5)], path.join(OUT, "interactions_2d_sheet.jpg"), 480);
  const v2 = await renderJob(ws, s2, "interactions_2d");
  report.interactions_2d = { contacts: c2, transfer: { ...t2, jumpPx: r4(jump2) }, video: v2, interactions: tl2.interactions };

  // ---- different sizes (2D) + limits ----------------------------------------------------------------
  group = "sizes_2d";
  const sizes2: unknown[] = [];
  for (const [scale, kind] of [
    [0.5, "handshake"],
    [0.75, "handshake"],
    [1.5, "handshake"],
    [0.6, "give_object"],
    [0.35, "high_five"],
  ] as [number, string][]) {
    const s = `size2d_${kind}_${String(scale).replace(".", "_")}`;
    await ws.createScene({ sceneId: s, canvas: { width: 960, height: 540, fps: FPS, background: "#cfe8f7" }, duration: 5 * FPS });
    await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "a", character: "pip", x: 380, y: 480, props: kind === "give_object" ? [{ id: "mug", asset: "mug", socket: "rightHand", scale: 0.5 }] : [] }, ctx()));
    await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "b", character: "pip", x: 600, y: 480, facing: "left", scale, z: 12 }, ctx()));
    const r = await interact(s, [{ id: "ix", interaction: kind, actors: ["a", "b"], start: 0.3, duration: 3, ...(kind === "give_object" ? { params: { object: "mug" } } : {}) }]);
    const c = await measuredContact(ws, s, "ix");
    const warn = r.warnings.filter((w) => w.code.startsWith("INTERACTION")).map((w) => ({ code: w.code, message: w.message }));
    sizes2.push({ interaction: kind, scale, measuredPx: c.worst, warnings: warn });
    if (warn.length) check(`${kind} with partner scale ${scale}: limit reported (arm too short), still rendered`, warn.some((w) => w.code === "INTERACTION_OUT_OF_REACH"), { px: c.worst, warn });
    else check(`${kind} with partner scale ${scale}: contact < 1 px`, c.worst < 1, { px: c.worst });
  }
  report.sizes_2d = sizes2;

  const out = { seconds: +((Date.now() - t0) / 1000).toFixed(1), passed: checks.filter((c) => c.ok).length, total: checks.length, checks, ...report };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(out, null, 2));
  console.log(`done in ${out.seconds} s; ${out.passed}/${out.total} checks passed`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
