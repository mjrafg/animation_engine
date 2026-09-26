/**
 * Multi-character interactions: reusable definitions applied to character instances, compiled into
 * the canonical timeline. No test authors a low-level keyframe for a character or an interaction.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import * as ops from "../src/api/operations.js";
import { BUILTIN_INTERACTIONS, InteractionDefinitionSchema } from "../src/characters/interaction-defs.js";
import { checkInteraction, interactionTimeline } from "../src/characters/interactions.js";
import * as ch from "../src/characters/operations.js";
import { EngineError } from "../src/errors.js";
import { blenderInfo } from "../src/scene3d/blender.js";
import * as ops3d from "../src/scene3d/operations.js";
import { validateScene3D } from "../src/scene3d/validate.js";
import { WorkspaceManager, type VideoWorkspace } from "../src/workspace/workspace.js";
import { tmpDir } from "./helpers.js";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "assets", "characters");
const HELLO = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "speech", "hello_pip.json"), "utf8"));
const HAS_BLENDER = blenderInfo().available;
const FPS = 24;
const F = (sec: number) => Math.round(sec * FPS);

/** A short mono 16-bit WAV tone (speech audio stand-in). */
function wav(seconds: number, hz: number): Buffer {
  const rate = 16000;
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * hz * i) / rate)), 44 + i * 2);
  return b;
}

let ROOT_DIR = "";
beforeAll(async () => {
  ROOT_DIR = tmpDir("aeix-");
  const mgr = new WorkspaceManager({ root: ROOT_DIR, libraries: { characters: LIB, interactions: path.join(ROOT, "assets", "interactions") } });
  const ws = mgr.create("w");
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"));
  await ws.importAsset({ kind: "file", file: path.join(LIB, "props", "mug.png"), origin: {} }, { assetId: "mug" });
  await ws.importAsset({ kind: "file", file: path.join(ROOT, "assets", "3d", "mug.glb"), origin: {} }, { assetId: "mug3d" });
  await ws.importAsset({ kind: "bytes", data: wav(2, 220), filename: "voice_a.wav", origin: {} }, { assetId: "voice_a" });
  await ws.importAsset({ kind: "bytes", data: wav(2, 330), filename: "voice_b.wav", origin: {} }, { assetId: "voice_b" });
}, 120_000);

function open() {
  const mgr = new WorkspaceManager({ root: ROOT_DIR, libraries: { characters: LIB, interactions: path.join(ROOT, "assets", "interactions") } });
  return { mgr, ws: mgr.open("w") };
}

async function pair2d(ws: VideoWorkspace, opts: { seconds?: number; b?: Record<string, unknown>; a?: Record<string, unknown> } = {}) {
  const { sceneId } = await ws.createScene({ canvas: { width: 960, height: 540, fps: FPS, background: "#cfe8f7" }, duration: (opts.seconds ?? 12) * FPS });
  const cx = ws.characterContext();
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "a", character: "pip", x: 380, y: 470, ...opts.a }, cx));
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "b", character: "pip", x: 700, y: 470, facing: "left", z: 12, ...opts.b }, cx));
  return sceneId;
}

const ix = (ws: VideoWorkspace, sceneId: string, operations: unknown[]) => ws.mutateScene(sceneId, (d) => ch.applyInteractionOps(d, operations, ws.characterContext()));
const act = (ws: VideoWorkspace, sceneId: string, inst: string, operations: unknown[]) => ws.mutateScene(sceneId, (d) => ch.applyCharacterActions(d, inst, operations, ws.characterContext()));
const addIx = (interaction: Record<string, unknown>) => ({ type: "add", interaction });
const addAct = (action: Record<string, unknown>) => ({ type: "add", action });

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return e as EngineError;
  }
  throw new Error("expected an error");
}

async function grips(ws: VideoWorkspace, sceneId: string, frame: number, parts: string[]) {
  const l = await ws.measureLayout(sceneId, frame, parts);
  return Object.fromEntries(l.layers.map((x) => [x.id, x]));
}
const d2 = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

describe("interaction definitions", () => {
  it("ship a reusable built-in library that validates", () => {
    expect(Object.keys(BUILTIN_INTERACTIONS).sort()).toEqual(["give_object", "handshake", "high_five", "hug", "push", "receive_object"]);
    for (const d of Object.values(BUILTIN_INTERACTIONS)) expect(InteractionDefinitionSchema.safeParse(d).success).toBe(true);
    const { ws } = open();
    const list = ws.listInteractions();
    expect(list.find((x) => x.id === "give_object")).toMatchObject({ actors: 2, roles: ["giver", "receiver"], params: ["object"], builtin: true });
    const hs = ws.describeInteraction("handshake");
    expect(hs.actors).toBe(2);
    expect(hs.phases.map((p) => p.name)).toEqual(["approach", "reach", "contact", "motion", "release", "return"]);
    expect(hs.channels.concurrent.join(" ")).toContain("talk");
    expect(hs.channels.owns.a).toMatchObject({ locomotion: true, facing: true });
  });

  it("registers custom definitions as data (no code changes) and rejects bad ones", async () => {
    const { mgr, ws } = open();
    expect(mgr.listInteractionPackages("interactions").map((p) => p.interactionId)).toContain("professor_greeting");
    const file = mgr.resolveLibraryFile("interactions", "professor_greeting.json");
    const r = ws.defineInteraction(JSON.parse(fs.readFileSync(file, "utf8")));
    expect(r.reused).toBe(false);
    expect(ws.defineInteraction(JSON.parse(fs.readFileSync(file, "utf8"))).reused).toBe(true);
    expect(ws.listInteractions().find((x) => x.id === "professor_greeting")).toMatchObject({ builtin: false, roles: ["professor", "student"] });
    expect(() => ws.defineInteraction({ ...BUILTIN_INTERACTIONS.hug })).toThrow(/built-in/);
    const bad = { ...JSON.parse(fs.readFileSync(file, "utf8")), id: "bad_one", effectors: [{ role: "nobody", hand: "right", target: "grip", from: "reach", until: "release" }] };
    const e = (() => {
      try {
        ws.defineInteraction(bad);
      } catch (x) {
        return x as EngineError;
      }
    })()!;
    expect(e.code).toBe("INTERACTION_INVALID");
    expect(JSON.stringify(e.details)).toContain("unknown role");
    const changed = { ...JSON.parse(fs.readFileSync(file, "utf8")), duration: { default: 5, min: 2 } };
    expect(() => ws.defineInteraction(changed)).toThrow(/replace/);

    // used in a scene exactly like a built-in: the professor waits (anchor first), the student walks up
    const sceneId = await pair2d(ws);
    await ix(ws, sceneId, [addIx({ interaction: "professor_greeting", actors: ["b", "a"], start: 0.5 })]);
    const tl: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
    expect(tl.interactions[0].alignment.actors.b.walks).toBe(false);
    expect(tl.interactions[0].alignment.actors.a.walks).toBe(true);
    // replacing the definition marks the scene stale until recompiled
    ws.defineInteraction(changed, { replace: true });
    const tl2: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
    expect(tl2.interactions[0].stale).toBe(true);
    await ws.mutateScene(sceneId, (d) => ch.recompileCharacters(d, ws.characterContext()));
    expect((interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext()) as any).interactions[0].stale).toBe(false);
  });
});

describe("2D interactions (Pip)", () => {
  it("handshake: approach, face each other, hands meet at contact, then return", async () => {
    const { ws } = open();
    const sceneId = await pair2d(ws);
    const r = await ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.5, duration: 3 })]);
    expect(r.warnings.filter((w) => w.code.startsWith("INTERACTION"))).toEqual([]);
    const doc = ws.getSceneDoc(sceneId);
    expect(doc.interactions[0]).toMatchObject({ id: "ix1", interaction: "handshake", definitionSha: expect.any(String) });
    const tl: any = interactionTimeline(doc, ws.characterContext(), F(2.3));
    const h = tl.interactions[0];
    expect(h.alignment.actors.a.walks).toBe(true);
    expect(h.alignment.actors.b.walks).toBe(false);
    expect(h.alignment.actors.a.facing).toBe(1);
    expect(h.alignment.actors.b.facing).toBe(-1);
    expect(h.injectedActions.a).toEqual(["ix1:approach:walk", "ix1:hold:idle"]);
    expect(tl.atFrame.interactions[0].phase.name).toBe("motion");
    expect(tl.atFrame.hands.length).toBe(2);
    // the actors' timelines show the scheduled interaction actions
    const ctl = ch.characterTimeline(doc, ws.characterContext(), "a")[0] as any;
    expect(ctl.interactionActions.map((x: any) => x.id)).toEqual(["ix1:approach", "ix1:hold"]);
    // measured contact: the two grip points coincide during the contact window
    const c = h.contacts[0];
    const worst: number[] = [];
    for (let f = F(c.contactStart); f < F(c.contactEnd); f += 2) {
      const m = await grips(ws, sceneId, f, ["a.hand_r", "b.hand_r"]);
      worst.push(d2(m["a.hand_r"].attachmentPoints.grip.world, m["b.hand_r"].attachmentPoints.grip.world));
    }
    expect(Math.max(...worst)).toBeLessThan(1);
    // the shake moves the clasped hands up and down
    const ys: number[] = [];
    for (let f = F(c.contactStart); f < F(c.contactEnd); f += 2) ys.push((await grips(ws, sceneId, f, ["a.hand_r"]))["a.hand_r"].attachmentPoints.grip.world.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
    // afterwards the arm is back to its own animation (hand hangs below the hips again)
    const after = await grips(ws, sceneId, F(4.5), ["a.hand_r", "a.hips"]);
    expect(after["a.hand_r"].attachmentPoints.grip.world.y).toBeGreaterThan(after["a.hips"].worldPivot.y);
    // everything is ordinary generated content owned by the actors
    expect(doc.animations.filter((t: any) => t.target === "a.upper_arm_r" && t.property === "rotation")[0].owner).toBe("a");
  });

  it("coexists with talk, smile and blink; owns locomotion, facing and the arms (structured conflicts, atomic)", async () => {
    const { ws } = open();
    const sceneId = await pair2d(ws);
    await ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.5, duration: 3 })]);
    await act(ws, sceneId, "a", [addAct({ action: "talk", start: 1.5, speech: HELLO }), addAct({ action: "smile", start: 1.5, duration: 2 })]);
    await act(ws, sceneId, "b", [addAct({ action: "blink", start: 2, count: 2, duration: 1 })]);
    const before = JSON.stringify(ws.getSceneDoc(sceneId));
    const cases: [string, Promise<unknown>, (e: EngineError) => void][] = [
      ["walk", act(ws, sceneId, "b", [addAct({ action: "walk", start: 2, duration: 1, direction: "right" })]), (e) => expect((e.details.issues as any)[0].details).toMatchObject({ channel: "locomotion", interactions: ["ix1"] })],
      ["wave", act(ws, sceneId, "a", [addAct({ action: "wave", start: 1.8, duration: 1 })]), (e) => expect((e.details.issues as any)[0].details).toMatchObject({ channel: "body-part", interactions: ["ix1"], instance: "a" })],
      ["turn", act(ws, sceneId, "b", [addAct({ action: "turn", start: 2, direction: "right" })]), (e) => expect((e.details.issues as any)[0].details).toMatchObject({ channel: "facing", interactions: ["ix1"] })],
      ["overlap", ix(ws, sceneId, [addIx({ interaction: "hug", actors: ["b", "a"], start: 3 })]), (e) => expect((e.details.issues as any)[0].details.interactions.sort()).toEqual(["ix1", "ix2"])],
    ];
    for (const [name, p, check] of cases) {
      const e = await codeOf(p);
      expect(e.code, name).toBe("ACTION_CONFLICT");
      check(e);
    }
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(before); // nothing applied
    // a wave with the arm the handshake does not use... Pip's wave is the right arm: allowed before/after
    await act(ws, sceneId, "a", [addAct({ action: "wave", start: 4, duration: 1 })]);
    // talk + smile still drive a's mouth during the handshake; b blinks independently
    const doc = ws.getSceneDoc(sceneId);
    const mouthA = doc.animations.find((t: any) => t.target === "a.mouth" && t.property === "asset");
    expect(mouthA.keyframes.filter((k: any) => k.frame >= F(1.5) && k.frame < F(3.5)).length).toBeGreaterThan(8);
    expect(mouthA.keyframes.some((k: any) => String(k.value).includes("smile"))).toBe(true);
    const eyesB = doc.animations.find((t: any) => t.target === "b.eyes" && t.property === "asset");
    expect(eyesB.keyframes.some((k: any) => k.frame >= F(2) && k.frame < F(3) && String(k.value).includes("closed"))).toBe(true);
  });

  it("reports incompatible characters, bad actors and missing params", async () => {
    const { ws } = open();
    const sceneId = await pair2d(ws);
    const e1 = await codeOf(ix(ws, sceneId, [addIx({ interaction: "tango", actors: ["a", "b"], start: 0 })]));
    expect(e1.code).toBe("INTERACTION_NOT_FOUND");
    const e2 = await codeOf(ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a"], start: 0 })]));
    expect(e2.code).toBe("INTERACTION_INVALID");
    const e3 = await codeOf(ix(ws, sceneId, [addIx({ interaction: "give_object", actors: ["a", "b"], start: 0 })]));
    expect(e3.code).toBe("INTERACTION_INVALID");
    expect(JSON.stringify(e3.details)).toContain("params.object");
    const e4 = await codeOf(ix(ws, sceneId, [addIx({ interaction: "give_object", actors: ["a", "b"], start: 0, params: { object: "mug" } })]));
    expect(e4.code).toBe("INTERACTION_OBJECT_NOT_HELD");
    const e5 = await codeOf(ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a", "ghost"], start: 0 })]));
    expect(e5.code).toBe("CHARACTER_NOT_FOUND");
    const e6 = await codeOf(ix(ws, sceneId, [{ type: "remove", id: "ix9" }]));
    expect(e6.code).toBe("INTERACTION_NOT_FOUND");

    // a character without hand sockets cannot shake hands
    const pip = ws.getCharacter("pip").def as any;
    const armless = { ...pip, id: "armless", sockets: { head: pip.sockets.head } };
    const chk = checkInteraction(BUILTIN_INTERACTIONS.handshake, [
      { id: "a", def: pip },
      { id: "x", def: armless },
    ], {});
    expect(chk.compatible).toBe(false);
    expect(chk.issues[0]).toMatchObject({ role: "b", actor: "x" });
    expect(chk.issues[0].problem).toContain("rightHand");
    const ok = checkInteraction(BUILTIN_INTERACTIONS.handshake, [
      { id: "a", def: pip },
      { id: "b", def: pip, scale: 0.7 },
    ], {});
    expect(ok.compatible).toBe(true);
    expect(ok.fit).toMatchObject({ unit: "px", heightRatio: 0.7 });
    expect((ok.fit as any).distance).toBeGreaterThan(60);
  });

  it("object transfer: follows the giver, changes owner exactly once, follows the receiver; survives reload", async () => {
    const { ws } = open();
    const sceneId = await pair2d(ws, { a: { props: [{ id: "mug", asset: "mug", socket: "rightHand", scale: 0.5 }] } });
    await ix(ws, sceneId, [addIx({ interaction: "give_object", actors: ["a", "b"], start: 0.5, params: { object: "mug" } })]);
    const doc = ws.getSceneDoc(sceneId);
    const tl: any = interactionTimeline(doc, ws.characterContext());
    const t = tl.interactions[0].transfer;
    expect(t).toMatchObject({ object: "mug", from: "a", to: "b", fromLayer: "a.mug", toLayer: "b.mug" });
    expect(tl.objects).toEqual([{ object: "a.mug", owners: [{ actor: "a", layer: "a.mug", from: 0, until: t.at }, { actor: "b", layer: "b.mug", from: t.at, until: null }] }]);
    // exactly one switch: a.mug visible until the transfer frame, b.mug from it
    const vis = (id: string) => doc.animations.find((x: any) => x.target === id && x.property === "visible").keyframes.map((k: any) => [k.frame, k.value]);
    expect(vis("a.mug")).toEqual([
      [0, true],
      [t.frame, false],
    ]);
    expect(vis("b.mug")).toEqual([
      [0, false],
      [t.frame, true],
    ]);
    // the object does not jump at the switch
    const m0 = await grips(ws, sceneId, t.frame - 1, ["a.mug", "a.hand_r"]);
    const m1 = await grips(ws, sceneId, t.frame, ["a.mug", "b.mug", "b.hand_r"]);
    for (let i = 0; i < 4; i++) expect(d2(m1["a.mug"].worldCorners[i], m1["b.mug"].worldCorners[i])).toBeLessThan(0.5);
    expect(d2(m0["a.mug"].worldCenter, m1["b.mug"].worldCenter)).toBeLessThan(3);
    // before: follows a's hand; after: follows b's hand (fixed offset while b's arm returns to rest)
    const off = async (f: number, who: string) => {
      const m = await grips(ws, sceneId, f, [`${who}.mug`, `${who}.hand_r`]);
      return d2(m[`${who}.mug`].worldCenter, m[`${who}.hand_r`].attachmentPoints.grip.world);
    };
    const offA = [await off(F(0.6), "a"), await off(F(1.8), "a")];
    expect(Math.abs(offA[0] - offA[1])).toBeLessThan(0.5);
    const offB = [await off(t.frame + 2, "b"), await off(F(5), "b")];
    expect(Math.abs(offB[0] - offB[1])).toBeLessThan(0.5);
    const late = await grips(ws, sceneId, F(5), ["b.mug", "b.hips"]);
    expect(late["b.mug"].visible).toBe(true);
    expect(late["b.mug"].worldCenter.y).toBeGreaterThan(late["b.hips"].worldPivot.y - 40); // hanging at b's side

    // ownership chains: b later gives it back to a
    await ix(ws, sceneId, [addIx({ interaction: "give_object", actors: ["b", "a"], start: 5, params: { object: "mug" } })]);
    const tl2: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
    expect(tl2.objects[0].owners.map((o: any) => `${o.actor}:${o.layer}`)).toEqual(["a:a.mug", "b:b.mug", "a:a.mug_ix2"]);

    // save / reload / re-render: a fresh workspace object reads the same document and recompiling is a no-op
    const saved = JSON.stringify(ws.getSceneDoc(sceneId));
    const { ws: ws2 } = open();
    expect(JSON.stringify(ws2.getSceneDoc(sceneId))).toBe(saved);
    await ws2.mutateScene(sceneId, (d) => ch.recompileCharacters(d, ws2.characterContext()));
    expect(JSON.stringify(ws2.getSceneDoc(sceneId))).toBe(saved);
    const a1 = await ws.renderFrame(sceneId, t.frame);
    const a2 = await ws2.renderFrame(sceneId, t.frame);
    expect(Buffer.compare(fs.readFileSync(ws.abs(a1.relativePath)), fs.readFileSync(ws2.abs(a2.relativePath)))).toBe(0);
  });

  it("is editable: move later, extend, replace, remove (removal restores the plain character timeline)", async () => {
    const { ws } = open();
    const plain = await pair2d(ws);
    const sceneId = await pair2d(ws);
    const strip = (doc: any) => JSON.stringify({ layers: doc.layers, animations: doc.animations, characters: doc.characters.map((c: any) => ({ ...c })) });
    await ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.5 })]);
    await ix(ws, sceneId, [{ type: "shift", by: 2 }]);
    expect(ws.getSceneDoc(sceneId).interactions[0].start).toBe(2.5);
    await ix(ws, sceneId, [{ type: "update", id: "ix1", patch: { duration: 4 } }]);
    let tl: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
    expect(tl.interactions[0]).toMatchObject({ start: 2.5, end: 6.5 });
    await ix(ws, sceneId, [{ type: "replace", id: "ix1", interaction: { interaction: "hug", actors: ["a", "b"], start: 3 } }]);
    tl = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
    expect(tl.interactions[0]).toMatchObject({ id: "ix1", interaction: "hug", start: 3 });
    expect(tl.interactions[0].contacts.length).toBe(4);
    await ix(ws, sceneId, [{ type: "remove", id: "ix1" }]);
    const doc = ws.getSceneDoc(sceneId);
    expect(doc.interactions).toBeUndefined();
    expect(strip(doc)).toBe(strip(ws.getSceneDoc(plain)));
  });

  it("character removal respects dependent interactions", async () => {
    const { ws } = open();
    const sceneId = await pair2d(ws, { a: { props: [{ id: "mug", asset: "mug", socket: "rightHand", scale: 0.5 }] } });
    await ix(ws, sceneId, [addIx({ interaction: "give_object", actors: ["a", "b"], start: 0.5, params: { object: "mug" } })]);
    const e = await codeOf(ws.mutateScene(sceneId, (d) => ch.removeCharacter(d, "a", {}, ws.characterContext())));
    expect(e.code).toBe("CHARACTER_IN_INTERACTION");
    expect(e.details.issues).toBeDefined();
    await ws.mutateScene(sceneId, (d) => ch.removeCharacter(d, "a", { removeInteractions: true }, ws.characterContext()));
    const doc = ws.getSceneDoc(sceneId);
    expect(doc.interactions).toBeUndefined();
    expect(doc.layers.some((l: any) => l.id === "b.mug")).toBe(false);
    expect(doc.layers.some((l: any) => l.id.startsWith("a."))).toBe(false);
  });

  it("adapts to different sizes (contact stays closed) and reports the limits", async () => {
    const { ws } = open();
    for (const scale of [0.6, 1.4]) {
      const sceneId = await pair2d(ws, { b: { scale, x: 760 } });
      const r = await ix(ws, sceneId, [addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.5, duration: 3 })]);
      expect(r.warnings.filter((w) => w.code === "INTERACTION_OUT_OF_REACH")).toEqual([]);
      const tl: any = interactionTimeline(ws.getSceneDoc(sceneId), ws.characterContext());
      const c = tl.interactions[0].contacts[0];
      const m = await grips(ws, sceneId, F((c.contactStart + c.contactEnd) / 2), ["a.hand_r", "b.hand_r"]);
      expect(d2(m["a.hand_r"].attachmentPoints.grip.world, m["b.hand_r"].attachmentPoints.grip.world), `scale ${scale}`).toBeLessThan(1);
    }
    // an extreme size difference: the small arm cannot reach the high-five height -> reported, still rendered
    const sceneId = await pair2d(ws, { b: { scale: 0.35, x: 700 } });
    const r = await ix(ws, sceneId, [addIx({ interaction: "high_five", actors: ["a", "b"], start: 0.5 })]);
    const w = r.warnings.find((x) => x.code === "INTERACTION_OUT_OF_REACH");
    expect(w).toBeDefined();
    expect((w!.details as any).actor).toBe("b");
  });
});

describe("independent speech, mouths and expressions per instance", () => {
  it("two characters talk at the same time without affecting each other", async () => {
    const { ws } = open();
    ws.saveSpeechTiming("line_a", { ...HELLO, audio: "voice_a" });
    ws.saveSpeechTiming("line_b", { audio: "voice_b", text: "Oh, hi!", words: [{ word: "Oh,", start: 0.1, end: 0.4 }, { word: "hi!", start: 0.5, end: 0.9 }] });
    const both = await pair2d(ws);
    await act(ws, both, "a", [addAct({ action: "talk", start: 1, speech: "line_a" }), addAct({ action: "smile", start: 1, duration: 3 })]);
    await act(ws, both, "b", [addAct({ action: "talk", start: 1.5, speech: "line_b" }), addAct({ action: "surprised", start: 1.2, duration: 1 })]);
    // the same actions on each character alone
    const onlyA = await pair2d(ws);
    await act(ws, onlyA, "a", [addAct({ action: "talk", start: 1, speech: "line_a" }), addAct({ action: "smile", start: 1, duration: 3 })]);
    const onlyB = await pair2d(ws);
    await act(ws, onlyB, "b", [addAct({ action: "talk", start: 1.5, speech: "line_b" }), addAct({ action: "surprised", start: 1.2, duration: 1 })]);
    const tracks = (sceneId: string, owner: string) =>
      JSON.stringify(
        ws
          .getSceneDoc(sceneId)
          .animations.filter((t: any) => t.owner === owner)
          .sort((x: any, y: any) => `${x.target}.${x.property}`.localeCompare(`${y.target}.${y.property}`)),
      );
    expect(tracks(both, "a")).toBe(tracks(onlyA, "a"));
    expect(tracks(both, "b")).toBe(tracks(onlyB, "b"));
    const doc = ws.getSceneDoc(both);
    const mouth = (id: string) => doc.animations.find((t: any) => t.target === `${id}.mouth` && t.property === "asset").keyframes;
    expect(JSON.stringify(mouth("a"))).not.toBe(JSON.stringify(mouth("b")));
    // each voice line is its own audio entry, owned by its speaker, starting at its talk
    expect(doc.audio.map((x: any) => [x.owner, x.startFrame]).sort()).toEqual([
      ["a", F(1)],
      ["b", F(1.5)],
    ]);
    // background blinks are seeded per instance: not in lockstep
    const tl = ch.characterTimeline(doc, ws.characterContext()) as any[];
    expect(JSON.stringify(tl[0].blinks)).not.toBe(JSON.stringify(tl[1].blinks));
    // two instances of the SAME character with the same generic talk still get their own timing
    const same = await pair2d(ws);
    await act(ws, same, "a", [addAct({ action: "talk", start: 1, duration: 2 })]);
    await act(ws, same, "b", [addAct({ action: "talk", start: 1, duration: 2 })]);
    const d2doc = ws.getSceneDoc(same);
    const ma = d2doc.animations.find((t: any) => t.target === "a.mouth" && t.property === "asset").keyframes;
    const mb = d2doc.animations.find((t: any) => t.target === "b.mouth" && t.property === "asset").keyframes;
    expect(JSON.stringify(ma)).not.toBe(JSON.stringify(mb));
  });
});

describe("3D interactions (Mika)", () => {
  async function pair3d(ws: VideoWorkspace, bScale = 0.8) {
    const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 320, height: 180, fps: FPS }, duration: 10 * FPS });
    const cx = ws.characterContext();
    await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "floor", primitive: { shape: "plane" } }], lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: { position: { x: 0.5, y: 1.3, z: 4.5 }, lookAt: { x: 0.2, y: 1, z: 0 } }, render: { quality: "draft" } }));
    await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "a", character: "mika", position: { x: -2, y: 0, z: 0 }, facing: "right", props: [{ id: "mug", asset: "mug3d", socket: "rightHand", follow: "position", position: { y: -0.08 } }] }, cx));
    await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "b", character: "mika", position: { x: 0.6, y: 0, z: 0 }, facing: "left", scale: bScale }, cx));
    return sceneId;
  }

  it("compiles to IK chains, transfer copies and ordinary tracks (validated)", async () => {
    const { ws } = open();
    const sceneId = await pair3d(ws);
    const r = await ix(ws, sceneId, [
      addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.2, duration: 3.5 }),
      addIx({ interaction: "give_object", actors: ["a", "b"], start: 4, params: { object: "mug" } }),
    ]);
    expect(r.warnings.filter((w) => w.code.startsWith("INTERACTION"))).toEqual([]);
    const doc = ws.getSceneDoc(sceneId);
    const a = doc.objects.find((o: any) => o.id === "a");
    expect(a.ik.right).toMatchObject({ upper: "upper_arm.R", lower: "forearm.R", end: "hand.R", side: "right" });
    // animated: weight and the moving target coordinates (z stays 0 here, so it is static)
    expect(doc.animations.filter((t: any) => t.target === "a" && t.property.startsWith("ik.right")).map((t: any) => t.property).sort()).toEqual(["ik.right.target.x", "ik.right.target.y", "ik.right.weight"]);
    expect(a.ik.right.target.z).toBe(0);
    const copy = doc.objects.find((o: any) => o.id === "b.mug");
    expect(copy).toMatchObject({ asset: "mug3d", attach: { object: "b", bone: "rightHand", follow: "position" }, meta: { character: "b", receivedFrom: "a" } });
    // different sizes: the aligned distance comes from both arms
    const tl: any = interactionTimeline(doc, ws.characterContext());
    expect(tl.interactions[0].alignment.distance).toBeGreaterThan(0.45);
    expect(tl.interactions[0].alignment.distance).toBeLessThan(0.9);
    // a bad IK chain is a structured validation error
    const bad = structuredClone(doc);
    bad.objects.find((o: any) => o.id === "a").ik.right.lower = "tail";
    const v = validateScene3D(bad, ws.assetLookup3D);
    expect(v.errors.map((e) => e.code)).toContain("BONE_NOT_FOUND");
  });

  it.skipIf(!HAS_BLENDER)("hands meet (different sizes) and the object moves from hand to hand without a jump", async () => {
    const { ws } = open();
    const sceneId = await pair3d(ws);
    await ix(ws, sceneId, [
      addIx({ interaction: "handshake", actors: ["a", "b"], start: 0.2, duration: 3.5 }),
      addIx({ interaction: "give_object", actors: ["a", "b"], start: 4, params: { object: "mug" } }),
    ]);
    const doc = ws.getSceneDoc(sceneId);
    const tl: any = interactionTimeline(doc, ws.characterContext());
    const gripOf = (o: any, grip: number) => {
      const h = o.bones.rightHand;
      const t = h.tail.world;
      const len = Math.hypot(t.x - h.world.x, t.y - h.world.y, t.z - h.world.z);
      return { x: h.world.x + ((t.x - h.world.x) / len) * grip, y: h.world.y + ((t.y - h.world.y) / len) * grip, z: h.world.z + ((t.z - h.world.z) / len) * grip };
    };
    const gA = doc.objects.find((o: any) => o.id === "a").ik.right.grip;
    const gB = doc.objects.find((o: any) => o.id === "b").ik.right.grip;
    const c = tl.interactions[0].contacts[0];
    for (const sec of [c.contactStart + 0.05, (c.contactStart + c.contactEnd) / 2]) {
      const m: any = await ws.measure3D(sceneId, F(sec), { objects: ["a", "b"] });
      const pa = gripOf(m.objects[0], gA);
      const pb = gripOf(m.objects[1], gB);
      expect(Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z)).toBeLessThan(0.01);
    }
    const t = tl.interactions[1].transfer;
    const pos = async (f: number) => {
      const m: any = await ws.measure3D(sceneId, f, { objects: ["a.mug", "b.mug"] });
      return Object.fromEntries(m.objects.map((o: any) => [o.id, o]));
    };
    const at = await pos(t.frame);
    expect(at["a.mug"].visible).toBe(false);
    expect(at["b.mug"].visible).toBe(true);
    const p0 = at["a.mug"].world.position; // where it would be in a's hand
    const p1 = at["b.mug"].world.position;
    expect(Math.hypot(p0.x - p1.x, p0.y - p1.y, p0.z - p1.z)).toBeLessThan(0.01);
    // after the transfer the mug follows b's hand
    const late: any = await ws.measure3D(sceneId, F(8), { objects: ["b", "b.mug"] });
    const hand = late.objects[0].bones.rightHand.world;
    const mug = late.objects[1].world.position;
    expect(Math.hypot(hand.x - mug.x, hand.y - mug.y, hand.z - mug.z)).toBeLessThan(0.15);
  }, 300_000);
});
