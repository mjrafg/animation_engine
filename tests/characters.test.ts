/**
 * Character runtime: prepared characters driven by high-level actions only. No test here writes a
 * single low-level keyframe for a character; everything comes from the runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ops from "../src/api/operations.js";
import { describeCharacter } from "../src/characters/capabilities.js";
import * as ch from "../src/characters/operations.js";
import { planSpeech, visemeForChar } from "../src/characters/speech.js";
import { CharacterDefinitionSchema } from "../src/characters/schema.js";
import { EngineError } from "../src/errors.js";
import { blenderInfo } from "../src/scene3d/blender.js";
import * as ops3d from "../src/scene3d/operations.js";
import { WorkspaceManager, type VideoWorkspace } from "../src/workspace/workspace.js";
import { tmpDir } from "./helpers.js";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "assets", "characters");
const HELLO = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "speech", "hello_pip.json"), "utf8"));
const HAS_BLENDER = blenderInfo().available;
const FPS = 24;
const F = (sec: number) => Math.round(sec * FPS);

async function setup(opts: { root?: string } = {}) {
  const root = opts.root ?? tmpDir("aechar-");
  const mgr = new WorkspaceManager({ root, libraries: { characters: LIB, models: path.join(ROOT, "assets", "3d") } });
  const ws = mgr.exists("w") ? mgr.open("w") : mgr.create("w");
  if (!ws.hasCharacter("pip")) await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  if (!ws.hasAsset("mug")) await ws.importAsset({ kind: "file", file: path.join(LIB, "props", "mug.png"), origin: {} }, { assetId: "mug" });
  return { root, mgr, ws };
}

async function scene2d(ws: VideoWorkspace, seconds = 14) {
  const { sceneId } = await ws.createScene({ canvas: { width: 960, height: 540, fps: FPS, background: "#cfe8f7" }, duration: seconds * FPS });
  await ws.mutateScene(sceneId, (d) => ops.addLayers(d, [{ id: "ground", fill: "#8fc97a", x: 480, y: 505, width: 960, height: 70 }]));
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "pip1", character: "pip", x: 150, y: 470 }, ws.characterContext()));
  return sceneId;
}

const act = (ws: VideoWorkspace, sceneId: string, operations: unknown[], inst = "pip1") => ws.mutateScene(sceneId, (d) => ch.applyCharacterActions(d, inst, operations, ws.characterContext()));
const add = (action: Record<string, unknown>) => ({ type: "add", action });

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }
  throw new Error("expected an error");
}

async function layerAt(ws: VideoWorkspace, sceneId: string, sec: number, ids: string[]) {
  const l = await ws.measureLayout(sceneId, F(sec), ids);
  return Object.fromEntries(l.layers.map((x) => [x.id, x]));
}

/** Static or animated value of a layer property at a frame, read from the canonical timeline. */
function valueAt(doc: any, target: string, prop: string, frame: number) {
  const tr = doc.animations.find((a: any) => a.target === target && a.property === prop);
  if (!tr) return doc.layers.find((l: any) => l.id === target)?.[prop];
  let v = tr.keyframes[0].value;
  for (const k of tr.keyframes) if (k.frame <= frame) v = k.value;
  return v;
}

describe("prepared character packages", () => {
  it("validate and describe their capabilities (2D pip, 3D mika)", () => {
    for (const id of ["pip", "mika"]) {
      const def = CharacterDefinitionSchema.parse(JSON.parse(fs.readFileSync(path.join(LIB, id, "character.json"), "utf8")));
      const d = describeCharacter(def);
      const names = d.actions.map((a) => a.name);
      for (const a of ["idle", "walk", "run", "talk", "smile", "blink", "wave", "point", "turn"]) expect(names, `${id}: ${a}`).toContain(a);
      expect(d.speech.talk).toBe(true);
      expect(d.compositionRules.length).toBeGreaterThan(3);
      if (id === "pip") {
        expect(d.expressions).toEqual(["neutral", "smile", "sad", "surprised"]);
        expect(names).toContain("look");
        expect(d.sockets.rightHand).toBe("hand_r:grip");
        expect(d.speech.mouthSets!.neutral).toHaveLength(8);
      } else {
        expect(d.expressions).toEqual(["neutral", "smile", "surprised"]); // not every character has every expression
        expect(names).not.toContain("look");
        expect(d.compatible).not.toContainEqual(["walk", "wave"]);
      }
    }
  });

  it("is prepared once per workspace and reused", async () => {
    const { ws, mgr } = await setup();
    const again = await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
    expect(again.reused).toBe(true);
    expect(ws.listAssets({ tag: "pip" }).length).toBe(Object.keys(ws.getCharacter("pip").def.kind === "2d" ? (ws.getCharacter("pip").def as any).assets : {}).length);
    expect(ws.listCharacters().map((c) => c.characterId)).toEqual(["pip"]);
    expect(mgr.listCharacterPackages("characters").map((p) => p.path).sort()).toEqual(["mika", "pip"]);
    expect((await codeOf(Promise.resolve().then(() => ws.getCharacter("nobody")))).code).toBe("CHARACTER_NOT_FOUND");
  });
});

describe("speech timing -> visemes", () => {
  it("maps provider-neutral alignment deterministically", () => {
    expect(["h", "e", "l", "o", "m", "f", "u", " ", "!"].map(visemeForChar)).toEqual(["AI", "E", "L", "O", "MBP", "FV", "U", "rest", "rest"]);
    const a = planSpeech(HELLO, HELLO.duration, 1, 1.5 / FPS);
    expect(a.source).toBe("characters");
    expect(a.spans.every((s, i) => i === 0 || s.start >= a.spans[i - 1].end - 1e-9)).toBe(true);
    expect(new Set(a.spans.map((s) => s.viseme)).size).toBeGreaterThanOrEqual(6);
    const w = planSpeech({ words: [{ word: "hello", start: 0, end: 0.5 }, { word: "moon", start: 0.7, end: 1.2 }] }, 1.3, 1, 0.05);
    expect(w.source).toBe("words");
    expect(w.spans.some((s) => s.viseme === "rest" && s.start >= 0.5 && s.end <= 0.7 + 1e-9)).toBe(true);
    const g1 = planSpeech(undefined, 2, 42, 0.06);
    expect(g1.source).toBe("generic");
    expect(planSpeech(undefined, 2, 42, 0.06)).toEqual(g1);
    expect(planSpeech(undefined, 2, 43, 0.06)).not.toEqual(g1);
  });
});

describe("2D character actions (pip)", () => {
  it("REQUIRED COMPOSITION: idle -> walk right -> stop -> talk + smile + blink -> walk back left", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws);
    ws.saveSpeechTiming("hello", HELLO);
    const r = await act(ws, sceneId, [
      add({ action: "idle", start: 0, duration: 2 }),
      add({ action: "walk", start: 2, duration: 3, direction: "right" }),
      add({ action: "talk", start: 5.5, speech: "hello" }),
      add({ action: "smile", start: 6, duration: 4 }), // keeps smiling into the walk back
      add({ action: "blink", start: 7, duration: 1.2, count: 2 }),
      add({ action: "walk", start: 9.5, duration: 3, direction: "left" }),
    ]);
    expect(r.warnings).toEqual([]);
    const doc = ws.getSceneDoc(sceneId);
    // everything generated is owned by the instance; the test wrote no keyframes
    expect(doc.animations.filter((a: any) => a.target !== "ground").every((a: any) => a.owner === "pip1")).toBe(true);
    expect(doc.characters[0].actions.map((a: any) => a.id)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);

    const root = async (sec: number) => (await layerAt(ws, sceneId, sec, ["pip1"])).pip1;
    const start = await root(1);
    expect(start.worldPivot.x).toBeCloseTo(150, 0);
    const stopped = await root(5.2);
    expect(stopped.worldPivot.x).toBeCloseTo(750, 0); // 3 s at 200 px/s
    expect(valueAt(doc, "pip1", "scaleX", F(5.2))).toBeGreaterThan(0); // faces right
    const back = await root(13);
    expect(back.worldPivot.x).toBeCloseTo(150, 0);
    expect(valueAt(doc, "pip1", "scaleX", F(13))).toBeLessThan(0); // mirrored: faces left
    // legs move while walking, not while standing
    const thigh = (sec: number) => valueAt(doc, "pip1.thigh_r", "rotation", F(sec));
    expect(Math.abs(thigh(3.3) - thigh(3.5)) + Math.abs(thigh(3.5) - thigh(3.7))).toBeGreaterThan(10);
    expect(Math.abs(thigh(7) - thigh(7.2))).toBeLessThan(1);
    // talking: many mouth shapes; neutral set before the smile, smile set during it
    const mouth = (sec: number) => valueAt(doc, "pip1.mouth", "asset", F(sec));
    const talking = new Set(Array.from({ length: F(3.5) }, (_, i) => mouth(5.5 + i / FPS)));
    expect(talking.size).toBeGreaterThanOrEqual(5);
    const beforeSmile = new Set(Array.from({ length: F(0.5) }, (_, i) => mouth(5.5 + i / FPS)));
    expect([...beforeSmile].every((a) => !String(a).includes("smile"))).toBe(true);
    const whileSmiling = Array.from({ length: F(2.5) }, (_, i) => String(mouth(6.3 + i / FPS)));
    expect(whileSmiling.some((a) => a.includes("smile"))).toBe(true);
    expect(mouth(9.3)).toBe("pip.mouth_smile"); // talk over, still smiling: closed smile
    expect(mouth(1)).toBe("pip.mouth_rest");
    expect(valueAt(doc, "pip1.brows", "asset", F(7))).toBe("pip.brows_happy");
    // blinking during the talk (explicit blinks at 7.0 s and 7.6 s)
    expect(valueAt(doc, "pip1.eyes", "asset", F(7) + 1)).toBe("pip.eyes_closed");
    expect(valueAt(doc, "pip1.eyes", "asset", F(7.6) + 1)).toBe("pip.eyes_closed");
    expect(valueAt(doc, "pip1.eyes", "asset", F(7.35))).toBe("pip.eyes_open");
    // renders
    const pv = await ws.renderPreview(sceneId, F(7.1));
    expect(pv.width).toBe(960);
  });

  it("speech timing drives the mouth; talk + smile + blink at the same time", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 6);
    ws.saveSpeechTiming("hello", HELLO);
    const smileAt = 1.7;
    await act(ws, sceneId, [add({ action: "talk", start: 1, speech: "hello" }), add({ action: "smile", start: smileAt, duration: 3 }), add({ action: "blink", start: 2.5 })]);
    const doc = ws.getSceneDoc(sceneId);
    const talk = doc.characters[0].actions.find((a: any) => a.action === "talk");
    expect(talk.speechId).toBe("hello"); // resolved inline + remembered
    expect(talk.speech.characters.length).toBe(HELLO.characters.length);
    const plan = planSpeech(HELLO, HELLO.duration, 0, 1.5 / FPS);
    const neutral: Record<string, string> = { rest: "pip.mouth_rest", MBP: "pip.mouth_MBP", AI: "pip.mouth_AI", E: "pip.mouth_E", O: "pip.mouth_O", U: "pip.mouth_U", FV: "pip.mouth_FV", L: "pip.mouth_L" };
    let checked = 0;
    for (const s of plan.spans) {
      const f0 = F(1) + F(s.start);
      const f1 = F(1) + F(s.end);
      if (f1 - f0 < 2 || (f1 + 2) / FPS > smileAt) continue; // before the smile starts: neutral set
      expect(valueAt(doc, "pip1.mouth", "asset", f0 + 1), `${s.viseme} at ${s.start}`).toBe(neutral[s.viseme]);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    const smiling = new Set(Array.from({ length: F(2) }, (_, i) => valueAt(doc, "pip1.mouth", "asset", F(smileAt + 0.3) + i)));
    expect([...smiling].some((a) => String(a).startsWith("pip.mouth_smile"))).toBe(true);
    expect(valueAt(doc, "pip1.eyes", "asset", F(2.5) + 1)).toBe("pip.eyes_closed");

    // generic fallback when no timing exists: deterministic
    const s2 = await scene2d(ws, 4);
    await act(ws, s2, [add({ action: "talk", start: 0.5, duration: 2 })]);
    const s3 = await scene2d(ws, 4);
    await act(ws, s3, [add({ action: "talk", start: 0.5, duration: 2 })]);
    const mouthTrack = (id: string) => ws.getSceneDoc(id).animations.find((a: any) => a.target === "pip1.mouth");
    expect(mouthTrack(s2).keyframes.length).toBeGreaterThan(8);
    expect(mouthTrack(s2)).toEqual(mouthTrack(s3));
  });

  it("walk + talk + wave compose (different channels/parts); props follow sockets", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 6);
    await ws.mutateScene(sceneId, (d) => ch.updateCharacter(d, "pip1", { props: [{ id: "mug", asset: "mug", socket: "leftHand" }] }, ws.characterContext()));
    await act(ws, sceneId, [add({ action: "walk", start: 0.5, duration: 4, direction: "right" }), add({ action: "talk", start: 1, duration: 3 }), add({ action: "wave", start: 2, duration: 1.5 })]);
    const doc = ws.getSceneDoc(sceneId);
    // the wave overrides the walking arm swing on the right arm only
    const armR = (s: number) => valueAt(doc, "pip1.upper_arm_r", "rotation", F(s));
    const armL = (s: number) => valueAt(doc, "pip1.upper_arm_l", "rotation", F(s));
    expect(armR(2.8)).toBeLessThan(-90);
    expect(Math.abs(armL(2.6) - armL(3.0))).toBeGreaterThan(5); // still swinging
    expect(valueAt(doc, "pip1.hand_r", "asset", F(2.8))).toBe("pip.hand_open");
    // mug is held in the left hand at every frame (measured world positions)
    for (const s of [0.2, 1.3, 2.7, 4.1]) {
      const l = await layerAt(ws, sceneId, s, ["pip1.mug", "pip1.hand_l"]);
      const grip = l["pip1.hand_l"].attachmentPoints.grip.world;
      expect(Math.hypot(l["pip1.mug"].worldPivot.x - grip.x, l["pip1.mug"].worldPivot.y - grip.y)).toBeLessThan(1);
    }
    const bad = await codeOf(ws.mutateScene(sceneId, (d) => ch.updateCharacter(d, "pip1", { props: [{ id: "x", asset: "mug", socket: "tail" }] }, ws.characterContext())));
    expect(bad.code).toBe("BONE_NOT_FOUND");
  });

  it("rejects conflicts and invalid actions with structured errors, leaving the scene unchanged", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 10);
    await act(ws, sceneId, [add({ action: "walk", start: 1, duration: 2, direction: "right" })]);
    const before = JSON.stringify(ws.getSceneDoc(sceneId));
    const cases: [unknown[], string, (e: EngineError) => void][] = [
      [[add({ action: "run", start: 2, duration: 2, direction: "left" })], "ACTION_CONFLICT", (e) => expect((e.details.issues as any)[0].details.channel).toBe("locomotion")],
      [[add({ action: "smile", start: 4, duration: 2 }), add({ action: "sad", start: 5, duration: 2 })], "ACTION_CONFLICT", (e) => expect((e.details.issues as any)[0].details.channel).toBe("expression")],
      [[add({ action: "wave", start: 4, duration: 2 }), add({ action: "point", start: 5, duration: 2 })], "ACTION_CONFLICT", (e) => expect((e.details.issues as any)[0].details.parts).toContain("upper_arm_r")],
      [[add({ action: "talk", start: 4, duration: 2 }), add({ action: "talk", start: 5, duration: 2 })], "ACTION_CONFLICT", () => {}],
      [[add({ action: "turn", start: 2, direction: "left" })], "ACTION_CONFLICT", (e) => expect((e.details.issues as any)[0].details.channel).toBe("facing")],
      [[add({ action: "dance", start: 4, duration: 1 })], "ACTION_NOT_SUPPORTED", (e) => expect((e.details.issues as any)[0].details.supported).toContain("wave")],
      [[add({ action: "expression", expression: "angry", start: 4, duration: 1 })], "ACTION_NOT_SUPPORTED", () => {}],
      [[add({ action: "walk", start: 4, duration: 1, direction: "camera" })], "INVALID_ACTION", () => {}],
      [[add({ action: "walk", start: 4, direction: "left" })], "INVALID_ACTION", () => {}],
      [[add({ action: "smile", start: 4 })], "INVALID_ACTION", () => {}],
      [[add({ action: "wave", start: 20, duration: 1 })], "ACTION_OUT_OF_RANGE", () => {}],
      [[add({ action: "talk", start: 4, speech: "nope" })], "SPEECH_NOT_FOUND", () => {}],
      [[{ type: "remove", id: "a99" }], "ACTION_NOT_FOUND", () => {}],
      [[add({ action: "walk", start: 4, duration: 1, direction: "left", bogus: 1 })], "INVALID_ARGUMENT", () => {}],
    ];
    for (const [opsList, code, more] of cases) {
      const e = await codeOf(act(ws, sceneId, opsList));
      expect([code, code === "INVALID_ARGUMENT" ? "UNSUPPORTED_PROPERTY" : code], JSON.stringify(opsList) + " -> " + e.message).toContain(e.code);
      more(e);
    }
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(before);
    // 2D walk + wave is allowed (legs and arm are different parts)
    await act(ws, sceneId, [add({ action: "wave", start: 1.5, duration: 1 })]);
  });

  it("edits actions without rebuilding by hand; hand-made content survives; owned tracks are protected", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 12);
    await ws.mutateScene(sceneId, (d) => ops.addLayers(d, [{ id: "sign", fill: "#ffcc00", x: 800, y: 300, width: 60, height: 40 }]));
    await ws.mutateScene(sceneId, (d) => ops.applyTimelineOps(d, [{ type: "keyframe.add", target: "sign", property: "rotation", frame: 0, value: 0 }, { type: "keyframe.add", target: "sign", property: "rotation", frame: 48, value: 20 }]));
    await act(ws, sceneId, [
      add({ id: "walk1", action: "walk", start: 1, duration: 2, direction: "right" }),
      add({ id: "talk1", action: "talk", start: 3.5, duration: 2 }),
      add({ id: "smile1", action: "smile", start: 3.5, duration: 2 }),
    ]);
    const x = async (s: number) => (await layerAt(ws, sceneId, s, ["pip1"])).pip1.worldPivot.x;
    expect(await x(2)).toBeCloseTo(350, 0);
    // move the walk 2 seconds later
    await act(ws, sceneId, [{ type: "update", id: "walk1", patch: { start: 3 } }, { type: "shift", ids: ["talk1", "smile1"], by: 2 }]);
    expect(await x(2)).toBeCloseTo(150, 0);
    expect(await x(4)).toBeCloseTo(350, 0);
    // extend talk, remove smile, replace walk with run
    await act(ws, sceneId, [{ type: "update", id: "talk1", patch: { duration: 4 } }, { type: "remove", id: "smile1" }, { type: "replace", id: "walk1", action: { action: "run", start: 3, duration: 1, direction: "right" } }]);
    const doc = ws.getSceneDoc(sceneId);
    expect(doc.characters[0].actions.map((a: any) => `${a.id}:${a.action}:${a.start}`)).toEqual(["walk1:run:3", "talk1:talk:5.5"]);
    expect(await x(4.5)).toBeCloseTo(150 + 430, 0);
    const lateMouth = new Set(Array.from({ length: F(1.2) }, (_, i) => valueAt(doc, "pip1.mouth", "asset", F(8.2) + i)));
    expect(lateMouth.size).toBeGreaterThan(2); // the extended talk (5.5 s + 4 s) is still moving the mouth at 8-9 s
    expect(doc.animations.filter((a: any) => a.target === "pip1.brows")).toEqual([]); // smile removed
    // hand-made layer + track untouched
    expect(doc.layers.find((l: any) => l.id === "sign")).toBeTruthy();
    expect(doc.animations.find((a: any) => a.target === "sign").keyframes).toHaveLength(2);
    // low-level edits of character-owned tracks/layers are refused
    for (const p of [
      ws.mutateScene(sceneId, (d) => ops.applyTimelineOps(d, [{ type: "keyframe.add", target: "pip1", property: "x", frame: 10, value: 5 }])),
      ws.mutateScene(sceneId, (d) => ops.updateLayer(d, "pip1.head", { rotation: 30 })),
      ws.mutateScene(sceneId, (d) => ops.removeLayer(d, { id: "pip1.head" })),
    ]) {
      expect((await codeOf(p)).code).toBe("OWNED_BY_CHARACTER");
    }
    // but new low-level content ON the character is fine: a hat parented to the head
    await ws.mutateScene(sceneId, (d) => ops.addLayers(d, [{ id: "hat", fill: "#aa2222", parent: "pip1.head", y: -95, width: 70, height: 20, z: 12 }]));
    await act(ws, sceneId, [add({ action: "wave", start: 8, duration: 1 })]);
    expect(ws.getSceneDoc(sceneId).layers.find((l: any) => l.id === "hat").parent).toBe("pip1.head");
    // removing the character keeps the hat (detached)
    await ws.mutateScene(sceneId, (d) => ch.removeCharacter(d, "pip1"));
    const after = ws.getSceneDoc(sceneId);
    expect(after.layers.map((l: any) => l.id).sort()).toEqual(["ground", "hat", "sign"]);
    expect(after.animations.every((a: any) => !a.owner)).toBe(true);
    expect(after.characters).toBeUndefined();
  });

  it("persists: save, reload in a new process-equivalent, render identical pixels; recompiling is deterministic", async () => {
    const root = tmpDir("aecharp-");
    let ws = (await setup({ root })).ws;
    const sceneId = await scene2d(ws, 6);
    ws.saveSpeechTiming("hello", HELLO);
    await act(ws, sceneId, [add({ action: "walk", start: 0.5, duration: 1.5, direction: "right" }), add({ action: "talk", start: 2.2, speech: "hello" }), add({ action: "smile", start: 2.5, duration: 2 }), add({ action: "blink", start: 3 })]);
    const frames = [F(1), F(2.6), F(3) + 1, F(4.5)];
    const hashes: string[] = [];
    for (const f of frames) hashes.push((await ws.renderFrame(sceneId, f)).pixelSha256);
    const saved = JSON.stringify(ws.getSceneDoc(sceneId));
    // reload from disk with fresh objects
    ws = new WorkspaceManager({ root, libraries: { characters: LIB } }).open("w");
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(saved);
    for (const [i, f] of frames.entries()) expect((await ws.renderFrame(sceneId, f)).pixelSha256).toBe(hashes[i]);
    // recompile from the stored high-level actions: identical document
    await ws.mutateScene(sceneId, (d) => ch.recompileCharacters(d, ws.characterContext()));
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(saved);
    // the saved timing can change later without affecting the scene (inline copy)
    ws.saveSpeechTiming("hello", { ...HELLO, characters: HELLO.characters.slice(0, 3) });
    await ws.mutateScene(sceneId, (d) => ch.recompileCharacters(d, ws.characterContext()));
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(saved);
  });

  it("background blinks never collide with scheduled blinks; blink sources are labelled", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 30);
    await act(ws, sceneId, [add({ action: "blink", start: 2, duration: 20, interval: 2.5, seed: 3 })]);
    const tl = ch.characterTimeline(ws.getSceneDoc(sceneId), ws.characterContext())[0];
    const sched = (tl.blinks ?? []).filter((b: any) => b.source !== "autoBlink").map((b: any) => b.at);
    const auto = (tl.blinks ?? []).filter((b: any) => b.source === "autoBlink").map((b: any) => b.at);
    expect(sched.length).toBeGreaterThanOrEqual(6);
    expect(auto.length).toBeGreaterThan(0); // before 2 s and after 22 s
    for (const a of auto) for (const s of sched) expect(Math.abs(a - s)).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it("keeps the existing low-level 2D path working in the same scene", async () => {
    const { ws } = await setup();
    const sceneId = await scene2d(ws, 3);
    await ws.mutateScene(sceneId, (d) => ops.addLayers(d, [{ id: "ball", fill: "#ff0000", x: 50, y: 50, width: 20, height: 20 }]));
    await ws.mutateScene(sceneId, (d) => ops.applyTimelineOps(d, [{ type: "track.set", target: "ball", property: "x", keyframes: [{ frame: 0, value: 50 }, { frame: 60, value: 900 }] }]));
    await act(ws, sceneId, [add({ action: "talk", start: 0, duration: 2 })]);
    const l = await layerAt(ws, sceneId, 1.25, ["ball"]);
    expect(l.ball.worldPivot.x).toBeCloseTo(475, 0);
  });
});

describe("3D character actions (mika)", () => {
  const setup3d = async () => {
    const { ws, mgr } = await setup();
    await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"));
    await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "mug.glb"), origin: {} }, { assetId: "mug3d" });
    const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 160, height: 90, fps: FPS }, duration: 10 * FPS });
    await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "floor", primitive: { shape: "plane" } }], lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: { position: { x: 0, y: 1.4, z: 6 }, lookAt: { x: 0, y: 1, z: 0 }, fov: 55 }, render: { quality: "draft" } }));
    await ws.mutateScene(sceneId, (d) =>
      ch.addCharacter(d, { id: "m1", character: "mika", position: { x: -2, y: 0, z: 0 }, props: [{ id: "mug", asset: "mug3d", socket: "rightHand" }] }, ws.characterContext()),
    );
    return { ws, sceneId };
  };

  it("uses the same action vocabulary: clips, facing, morph targets, conflicts", async () => {
    const { ws, sceneId } = await setup3d();
    const e = await codeOf(act(ws, sceneId, [add({ action: "walk", start: 1, duration: 2, direction: "right" }), add({ action: "wave", start: 2, duration: 1 })], "m1"));
    expect(e.code).toBe("ACTION_CONFLICT");
    await act(ws, sceneId, [
      add({ action: "walk", start: 1, duration: 2, direction: "right" }),
      add({ action: "turn", start: 3.1, direction: "camera" }),
      add({ action: "talk", start: 3.5, duration: 2.5 }),
      add({ action: "smile", start: 4, duration: 2 }),
      add({ action: "blink", start: 5 }),
      add({ action: "wave", start: 6.2, duration: 1.5 }),
      add({ action: "run", start: 8, duration: 1, direction: "left" }),
    ], "m1");
    const doc = ws.getSceneDoc(sceneId);
    const track = (p: string) => doc.animations.find((a: any) => a.target === "m1" && a.property === p);
    expect(track("clip").keyframes.map((k: any) => k.value)).toEqual(["idle", "walk", "idle", "wave", "idle", "run", "idle"]);
    const at = (p: string, f: number) => {
      let v = track(p).keyframes[0].value;
      for (const k of track(p).keyframes) if (k.frame <= f) v = k.value;
      return v;
    };
    expect(at("rotation.y", F(2.5))).toBeCloseTo(90, 0); // walking right faces +x
    expect(at("rotation.y", F(4))).toBeCloseTo(0, 0); // turned to the camera
    expect(at("position.x", F(3.5))).toBeCloseTo(0.6, 2); // 2 s at 1.3 m/s from -2
    expect(Math.max(...track("morph.mouth_open").keyframes.map((k: any) => k.value))).toBeGreaterThan(0.3);
    expect(at("morph.smile", F(5))).toBeGreaterThan(0.9);
    expect(Math.max(...track("morph.blink").keyframes.map((k: any) => k.value))).toBeGreaterThan(0.9);
    const mug = doc.objects.find((o: any) => o.id === "m1.mug");
    expect(mug.attach).toMatchObject({ object: "m1", bone: "rightHand" });
  });

  it.skipIf(!HAS_BLENDER)("renders and measures: the prop follows the hand through actions", async () => {
    const { ws, sceneId } = await setup3d();
    await act(ws, sceneId, [add({ action: "walk", start: 0.5, duration: 1.5, direction: "right" }), add({ action: "wave", start: 3, duration: 1.5 })], "m1");
    for (const s of [1, 3.8]) {
      const m = await ws.measure3D(sceneId, F(s), { objects: ["m1", "m1.mug"] });
      const hand = m.objects.find((o) => o.id === "m1")!.bones.rightHand.world;
      const cup = m.objects.find((o) => o.id === "m1.mug")!.world.position;
      expect(Math.hypot(cup.x - hand.x, cup.y - hand.y, cup.z - hand.z)).toBeLessThan(0.01);
    }
    const pv = await ws.renderPreview(sceneId, F(3.8));
    expect(pv.width).toBe(160);
  }, 120_000);
});
