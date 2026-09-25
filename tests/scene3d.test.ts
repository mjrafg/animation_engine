/**
 * 3D support: glTF inspection, 3D scene validation / evaluation / operations, workspace
 * integration and error codes. Tests that need the Blender backend are skipped when Blender is
 * not installed (the pure-TypeScript parts always run).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ops from "../src/api/operations.js";
import { EngineError } from "../src/errors.js";
import { blenderInfo } from "../src/scene3d/blender.js";
import { clipSegments, compileTimeline3D, evaluateScene3D } from "../src/scene3d/evaluate.js";
import { inspectGltf, type ModelInfo } from "../src/scene3d/gltf.js";
import * as ops3d from "../src/scene3d/operations.js";
import { Scene3DSchema } from "../src/scene3d/schema.js";
import { validateScene3D } from "../src/scene3d/validate.js";
import { RenderJobs } from "../src/workspace/jobs.js";
import { WorkspaceManager } from "../src/workspace/workspace.js";
import { tmpDir } from "./helpers.js";

const ASSETS = path.resolve(__dirname, "..", "assets", "3d");
const charBytes = fs.readFileSync(path.join(ASSETS, "character.glb"));
const character = inspectGltf(charBytes, "character.glb");
const mug = inspectGltf(fs.readFileSync(path.join(ASSETS, "mug.glb")), "mug.glb");
const lookup = (id: string) => ({ mika: { kind: "model", model: character }, mug: { kind: "model", model: mug }, pic: { kind: "image" } } as Record<string, { kind: string; model?: ModelInfo }>)[id];
const HAS_BLENDER = blenderInfo().available;

const scene = (extra: Record<string, unknown> = {}) => ({
  kind: "3d",
  canvas: { width: 160, height: 90, fps: 24, background: "#000000" },
  duration: 48,
  ...extra,
});

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as EngineError).code).toBe(code);
    return e as EngineError;
  }
  throw new Error(`expected ${code}`);
}

describe("glTF inspection", () => {
  it("describes clips, skeleton, sockets and morph targets", () => {
    expect(character.format).toBe("glb");
    expect(character.rigged).toBe(true);
    expect(character.clips.map((c) => c.name).sort()).toEqual(["idle", "walk", "wave"]);
    expect(character.clips.find((c) => c.name === "walk")!.duration).toBeCloseTo(1, 2);
    expect(character.sockets).toMatchObject({ rightHand: "hand.R", leftHand: "hand.L", head: "head", root: "root" });
    expect(character.morphTargets.sort()).toEqual(["blink", "mouth_oh", "mouth_open", "smile"]);
    expect(character.bounds!.size[1]).toBeGreaterThan(1.5);
    expect(mug.rigged).toBe(false);
    expect(mug.clips).toEqual([]);
  });

  it("rejects invalid files with INVALID_ASSET", async () => {
    await expectCode(() => inspectGltf(Buffer.from("definitely not a model"), "x.glb"), "INVALID_ASSET");
    await expectCode(() => inspectGltf(charBytes.subarray(0, 40), "cut.glb"), "INVALID_ASSET");
    const external = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "model.bin", byteLength: 4 }] }));
    const e = await expectCode(() => inspectGltf(external, "external.gltf"), "INVALID_ASSET");
    expect(e.message).toMatch(/embedded|glb|uri/i);
    const v1 = Buffer.from(JSON.stringify({ asset: { version: "1.0" } }));
    await expectCode(() => inspectGltf(v1, "old.gltf"), "INVALID_ASSET");
  });
});

describe("3D scene validation", () => {
  it("accepts a valid scene and fills defaults", () => {
    const r = validateScene3D(scene({ objects: [{ id: "mika", asset: "mika", clip: "idle" }] }), lookup);
    expect(r.ok).toBe(true);
    expect(r.scene!.camera.fov).toBe(40);
    expect(r.scene!.objects[0].scale).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("reports missing clips, bones, morphs and assets with their own codes", () => {
    const r = validateScene3D(
      scene({
        objects: [
          { id: "mika", asset: "mika", clip: "dance", morphs: { frown: 1 } },
          { id: "cup", asset: "mug", attach: { object: "mika", bone: "tail" } },
          { id: "cup2", asset: "mug", attach: { object: "cup", bone: "rightHand" } },
          { id: "ghost", asset: "nope" },
          { id: "flat", asset: "pic" },
        ],
      }),
      lookup,
    );
    expect(codes(r)).toEqual(expect.arrayContaining(["CLIP_NOT_FOUND", "MORPH_NOT_FOUND", "BONE_NOT_FOUND", "MISSING_ASSET", "INVALID_ASSET"]));
    const clip = r.errors.find((e) => e.code === "CLIP_NOT_FOUND")!;
    expect(clip.details!.available).toEqual(expect.arrayContaining(["walk", "idle", "wave"]));
    const bone = r.errors.find((e) => e.code === "BONE_NOT_FOUND" && e.path.includes("bone"))!;
    expect((bone.details!.sockets as any).rightHand).toBe("hand.R");
  });

  it("rejects invalid transforms and values", () => {
    for (const bad of [
      { id: "a", position: { x: "1", y: 0, z: 0 } },
      { id: "a", position: { x: 1, y: 0 } },
      { id: "a", scale: { x: 1, y: 1, z: Number.NaN } },
      { id: "a", rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { id: "a", clipSpeed: 0 },
      { id: "a", morphs: { smile: 2 } },
    ]) {
      const r = validateScene3D(scene({ objects: [bad] }), lookup);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateScene3D(scene({ camera: { fov: 0 } }), lookup).ok).toBe(false);
    expect(validateScene3D(scene({ lights: [{ id: "l", type: "laser", intensity: 1 }] }), lookup).ok).toBe(false);
  });

  it("checks parents, cycles, reserved ids and animation tracks", () => {
    const r = validateScene3D(
      scene({
        objects: [
          { id: "a", parent: "b" },
          { id: "b", parent: "a" },
          { id: "camera" },
          { id: "c", parent: "missing" },
        ],
        lights: [{ id: "a", type: "sun", intensity: 1 }],
        animations: [
          { target: "nobody", property: "position.x", keyframes: [{ frame: 0, value: 1 }] },
          { target: "b", property: "opacity", keyframes: [{ frame: 0, value: 1 }] },
          { target: "b", property: "clip", keyframes: [{ frame: 0, value: "walk", interpolation: "linear" }] },
        ],
      }),
      lookup,
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining(["PARENT_CYCLE", "RESERVED_LAYER_ID", "MISSING_PARENT", "DUPLICATE_LAYER_ID", "MISSING_TARGET", "UNSUPPORTED_PROPERTY", "INVALID_INTERPOLATION"]),
    );
  });
});

describe("3D timeline evaluation", () => {
  const s = Scene3DSchema.parse(
    scene({
      objects: [{ id: "mika", asset: "mika", clip: "walk", clipBlend: 4 }],
      animations: [
        { target: "mika", property: "clip", keyframes: [{ frame: 0, value: "walk" }, { frame: 24, value: "wave" }, { frame: 36, value: "" }] },
        { target: "mika", property: "position.x", keyframes: [{ frame: 0, value: 0 }, { frame: 24, value: 2 }] },
        { target: "mika", property: "morph.smile", keyframes: [{ frame: 10, value: 0 }, { frame: 20, value: 1 }] },
        { target: "camera", property: "lookAt.y", keyframes: [{ frame: 0, value: 1 }, { frame: 48, value: 2 }] },
      ],
    }),
  );
  const models = (id: string) => (id === "mika" ? character : undefined);

  it("uses the 2D keyframe semantics for transforms, morphs and camera", () => {
    expect(evaluateScene3D(s, 12, models).objects[0].position.x).toBeCloseTo(1);
    expect(evaluateScene3D(s, 40, models).objects[0].position.x).toBe(2);
    expect(evaluateScene3D(s, 15, models).objects[0].morphs.smile).toBeCloseTo(0.5);
    expect(evaluateScene3D(s, 0, models).objects[0].morphs.smile).toBe(0);
    const cam = evaluateScene3D(s, 24, models).camera;
    expect(cam.lookAt).toEqual({ x: 0, y: 1.5, z: 0 });
  });

  it("derives clip segments, clip time, looping and crossfades", () => {
    expect(clipSegments(s.objects[0], compileTimeline3D(s))).toEqual([
      { start: 0, clip: "walk" },
      { start: 24, clip: "wave" },
      { start: 36, clip: null },
    ]);
    // walk is 1 s long at 24 fps: frame 30 of the loop -> 0.25 s
    const f6 = evaluateScene3D(s, 6, models).objects[0].clips;
    expect(f6).toEqual([{ name: "walk", time: 0.25, weight: 1 }]);
    // 2 frames into a 4-frame crossfade: wave 50 %, walk 50 % (walk keeps running: 26/24 s -> 0.0833)
    const f26 = evaluateScene3D(s, 26, models).objects[0].clips;
    expect(f26[0]).toMatchObject({ name: "wave", weight: 0.5 });
    expect(f26[0].time).toBeCloseTo(2 / 24);
    expect(f26[1].name).toBe("walk");
    expect(f26[1].time).toBeCloseTo(2 / 24);
    // after "" the clip fades to the rest pose
    const f38 = evaluateScene3D(s, 38, models).objects[0].clips;
    expect(f38).toEqual([{ name: "wave", time: expect.any(Number), weight: 0.5 }]);
    expect(evaluateScene3D(s, 45, models).objects[0].clips).toEqual([]);
  });

  it("holds the last pose when clipLoop is false", () => {
    const t = Scene3DSchema.parse(scene({ objects: [{ id: "mika", asset: "mika", clip: "walk", clipLoop: false, clipSpeed: 2 }] }));
    expect(evaluateScene3D(t, 6, models).objects[0].clips[0].time).toBeCloseTo(0.5);
    expect(evaluateScene3D(t, 40, models).objects[0].clips[0].time).toBeCloseTo(character.clips.find((c) => c.name === "walk")!.duration);
  });
});

describe("3D operations", () => {
  const base = () => ops3d.createScene3D({ canvas: { width: 160, height: 90, fps: 24 }, duration: 48 });
  const run = <T>(fn: () => T) => ops.withAssets3D(lookup, fn);

  it("adds, updates (per-axis merge) and removes objects and lights atomically", () => {
    const c = base();
    expect(c.ok).toBe(true);
    let doc = (c as any).scene;
    const add = run(() => ops3d.addEntities3D(doc, { objects: [{ id: "cup", asset: "mug", attach: { object: "mika", bone: "rightHand" } }, { id: "mika", asset: "mika" }], lights: [{ id: "sun", type: "sun", intensity: 2 }] }));
    expect(add.ok).toBe(true);
    doc = (add as any).scene;
    const up = run(() => ops3d.updateEntity3D(doc, "mika", { position: { y: 2 }, clip: "wave" }));
    expect(up.ok).toBe(true);
    doc = (up as any).scene;
    expect(doc.objects.find((o: any) => o.id === "mika").position).toEqual({ x: 0, y: 2, z: 0 });
    const badClip = run(() => ops3d.updateEntity3D(doc, "mika", { clip: "moonwalk" }));
    expect(badClip.ok).toBe(false);
    expect(codes(badClip as any)).toContain("CLIP_NOT_FOUND");
    const refuse = run(() => ops3d.removeEntity3D(doc, "mika"));
    expect(codes(refuse as any)).toContain("HAS_CHILDREN");
    const detach = run(() => ops3d.removeEntity3D(doc, "mika", "detach"));
    expect(detach.ok).toBe(true);
    expect((detach as any).scene.objects.map((o: any) => o.id)).toEqual(["cup"]);
    const cascade = run(() => ops3d.removeEntity3D(doc, "mika", "cascade"));
    expect((cascade as any).result.removed.sort()).toEqual(["cup", "mika"]);
    // failed batch adds nothing
    const bad = run(() => ops3d.addEntities3D(doc, { objects: [{ id: "x", asset: "mika", clip: "nope" }, { id: "y" }] }));
    expect(bad.ok).toBe(false);
  });

  it("shares the timeline ops with 2D and checks 3D targets", () => {
    let doc = (run(() => ops3d.addEntities3D((base() as any).scene, { objects: [{ id: "mika", asset: "mika" }] })) as any).scene;
    const r = run(() =>
      ops.applyTimelineOps(doc, [
        { type: "keyframe.add", target: "mika", property: "position.x", frame: 0, value: 0 },
        { type: "keyframe.add", target: "mika", property: "morph.smile", frame: 10, value: 1 },
        { type: "keyframe.add", target: "camera", property: "fov", frame: 0, value: 30 },
        { type: "keyframe.add", target: "world", property: "strength", frame: 0, value: 0.5 },
      ]),
    );
    expect(r.ok).toBe(true);
    doc = (r as any).scene;
    const miss = run(() => ops.applyTimelineOps(doc, [{ type: "keyframe.add", target: "ghost", property: "position.x", frame: 0, value: 1 }]));
    expect(codes(miss as any)).toContain("MISSING_TARGET");
    const morph = run(() => ops.applyTimelineOps(doc, [{ type: "keyframe.add", target: "mika", property: "morph.frown", frame: 0, value: 1 }]));
    expect(codes(morph as any)).toContain("MORPH_NOT_FOUND");
    const clip = run(() => ops.applyTimelineOps(doc, [{ type: "keyframe.add", target: "mika", property: "clip", frame: 5, value: "fly" }]));
    expect(codes(clip as any)).toContain("CLIP_NOT_FOUND");
    const settings = run(() => ops3d.setSettings3D(doc, { camera: { position: { z: 9 } }, render: { quality: "draft" } }));
    expect((settings as any).scene.camera.position).toEqual({ x: 0, y: 1.6, z: 9 });
    expect(run(() => ops3d.setSettings3D(doc, { camera: { fov: 500 } })).ok).toBe(false);
  });
});

describe("3D in the workspace", () => {
  const setup = async () => {
    const root = tmpDir("ae3d-");
    const mgr = new WorkspaceManager({ root, libraries: { models: ASSETS } });
    const ws = mgr.create("w3d");
    const imp = (file: string, assetId: string) => ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("models", file), origin: {} }, { assetId });
    await imp("character.glb", "mika");
    await imp("mug.glb", "mug");
    return { root, mgr, ws };
  };

  it("imports models as reusable assets with model facts", async () => {
    const { ws, mgr } = await setup();
    const rec = ws.getAsset("mika");
    expect(rec.kind).toBe("model");
    expect(rec.mime).toBe("model/gltf-binary");
    expect(rec.model!.clips.length).toBe(3);
    const again = await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("models", "character.glb"), origin: {} });
    expect(again.reused).toBe(true);
    expect(mgr.listLibrary("models").filter((f) => f.kind === "model").map((f) => f.path).sort()).toEqual(["character.glb", "mug.glb", "room.glb", "third_party/fox/Fox.glb"]);
    await expectCode(ws.importAsset({ kind: "bytes", data: Buffer.from("junk"), filename: "bad.glb", origin: {} }), "INVALID_ASSET");
    expect(ws.listAssets().length).toBe(2); // the failed import left nothing behind
  });

  it("creates and edits 3D scenes with stable error codes, leaving the stored scene unchanged on failure", async () => {
    const { ws } = await setup();
    const { sceneId, kind } = await ws.createScene({ kind: "3d", canvas: { width: 160, height: 90, fps: 24 }, duration: 24 });
    expect(kind).toBe("3d");
    await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "mika", asset: "mika", clip: "walk" }] }));
    const before = JSON.stringify(ws.getSceneDoc(sceneId));
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.updateEntity3D(d, "mika", { clip: "fly" })), "CLIP_NOT_FOUND");
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "cup", asset: "mug", attach: { object: "mika", bone: "tail" } }] })), "BONE_NOT_FOUND");
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.updateEntity3D(d, "mika", { morphs: { frown: 1 } })), "MORPH_NOT_FOUND");
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "x", asset: "nothing" }] })), "ASSET_NOT_FOUND");
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { overlay: { scene: "nope" } })), "VALIDATION_FAILED");
    expect(JSON.stringify(ws.getSceneDoc(sceneId))).toBe(before);
    const view = ws.sceneView(sceneId) as any;
    expect(view.kind).toBe("3d");
    expect(view.assetsUsed).toEqual(["mika"]);
    expect(ws.listScenes()[0]).toMatchObject({ kind: "3d", objects: 1 });
    // 2D-only paths refuse a 3D scene clearly
    await expectCode(ws.engine(sceneId), "INVALID_ARGUMENT");
    // overlays must be 2D scenes with the same canvas
    const s2 = await ws.createScene({ sceneId: "flat", canvas: { width: 160, height: 90, fps: 24, background: "#00000000" }, duration: 24 });
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { overlay: { scene: s2.sceneId } }));
    const wrong = await ws.createScene({ sceneId: "wide", canvas: { width: 320, height: 90, fps: 24 }, duration: 24 });
    await expectCode(ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { overlay: { scene: wrong.sceneId } })), "VALIDATION_FAILED");
  });

  it("isolates assets per workspace", async () => {
    const { mgr } = await setup();
    const other = mgr.create("other");
    const { sceneId } = await other.createScene({ kind: "3d", duration: 24 });
    await expectCode(other.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "mika", asset: "mika" }] })), "ASSET_NOT_FOUND");
  });

  it("keeps 2D scenes working next to 3D ones", async () => {
    const { ws } = await setup();
    const { sceneId } = await ws.createScene({ canvas: { width: 64, height: 32, fps: 10, background: "#ff0000" }, duration: 5 });
    expect(ws.sceneKind(sceneId)).toBe("2d");
    await ws.mutateScene(sceneId, (d) => ops.addLayers(d, [{ id: "box", fill: "#00ff00", x: 32, y: 16, width: 10, height: 10 }]));
    const f = await ws.renderFrame(sceneId, 0);
    expect(f.width).toBe(64);
    expect((ws.sceneView(sceneId) as any).kind).toBe("2d");
  });

  describe.skipIf(!HAS_BLENDER)("with the Blender backend", () => {
    it("measures attachments following a bone and renders previews", async () => {
      const { ws } = await setup();
      const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 160, height: 90, fps: 24 }, duration: 48 });
      await ws.mutateScene(sceneId, (d) =>
        ops3d.addEntities3D(d, {
          objects: [
            { id: "floor", primitive: { shape: "plane" } },
            { id: "mika", asset: "mika", clip: "wave" },
            { id: "cup", asset: "mug", attach: { object: "mika", bone: "rightHand" } },
          ],
          lights: [{ id: "sun", type: "sun", intensity: 3 }],
        }),
      );
      await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: { position: { x: 0, y: 1.2, z: 5 }, lookAt: { object: "mika", bone: "spine" } }, render: { quality: "draft" } }));
      const dists: number[] = [];
      const heights: number[] = [];
      for (const f of [0, 12, 24]) {
        const m = await ws.measure3D(sceneId, f, { objects: ["mika", "cup"] });
        const mika = m.objects.find((o) => o.id === "mika")!;
        const cup = m.objects.find((o) => o.id === "cup")!;
        const hand = mika.bones.rightHand.world;
        dists.push(Math.hypot(cup.world.position.x - hand.x, cup.world.position.y - hand.y, cup.world.position.z - hand.z));
        heights.push(hand.y);
        expect(mika.asset).toBe("mika");
        expect(mika.clips[0].name).toBe("wave");
        expect(mika.screen.onScreen).toBe(true);
      }
      expect(Math.max(...dists)).toBeLessThan(0.01); // attached at the hand joint, at every frame
      expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.5); // the wave raised the hand
      await expectCode(ws.measure3D(sceneId, 0, { objects: ["ghost"] }), "LAYER_NOT_FOUND");
      await expectCode(ws.measure3D(sceneId, 99), "INVALID_FRAME");
      const pv = await ws.renderPreview(sceneId, 12);
      expect(pv.width).toBe(160);
      expect(fs.existsSync(ws.abs(pv.view!.relativePath))).toBe(true);
      const dbg = (await ws.renderPreview(sceneId, 12, { debug: true })) as any;
      expect(dbg.kind).toBe("debug-preview");
      expect(dbg.measurement.objects.length).toBe(3);
      const insp = await ws.inspectAsset("mug");
      expect((insp as any).view.bytes).toBeLessThan(150_000);
    }, 120_000);

    it("renders a short 3D video with audio through a render job", async () => {
      const { ws } = await setup();
      const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 128, height: 72, fps: 12 }, duration: 6 });
      await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "mika", asset: "mika", clip: "walk" }], lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
      await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { render: { quality: "draft" }, camera: { lookAt: { object: "mika" } } }));
      const wav = Buffer.alloc(44 + 48000);
      wav.write("RIFF", 0); wav.writeUInt32LE(36 + 48000, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(48000, 40);
      await ws.importAsset({ kind: "bytes", data: wav, filename: "silence.wav", origin: {} }, { assetId: "snd" });
      await ws.mutateScene(sceneId, (d) => ops.setAudio(d, ws.audioEntries([{ assetId: "snd" }])));
      const jobs = new RenderJobs(ws);
      const job = await jobs.start(sceneId, {});
      const done = await jobs.wait(job.renderId, 110_000);
      expect(done.status, JSON.stringify(done.error)).toBe("completed");
      expect(done.artifact!.durationSeconds).toBeCloseTo(0.5);
      expect(fs.statSync(ws.abs(done.artifact!.relativePath)).size).toBeGreaterThan(1000);
    }, 120_000);

    it("reports render failures for broken model files", async () => {
      const { ws } = await setup();
      const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 64, height: 36, fps: 12 }, duration: 4 });
      await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "cup", asset: "mug" }] }));
      const file = ws.assetFile("mug");
      const bytes = fs.readFileSync(file);
      // valid header and JSON, garbage binary chunk
      fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, bytes.length / 2), Buffer.alloc(bytes.length / 2, 0xff)]));
      const e = await ws.renderPreview(sceneId, 0).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(EngineError);
      expect(e.code).toBe("INVALID_ASSET");
      expect(e.message).toMatch(/import/i);
      fs.rmSync(file);
      await expectCode(ws.renderPreview(sceneId, 0), "ASSET_NOT_FOUND");
    }, 120_000);
  });
});

describe("third-party glTF (Fox sample)", () => {
  const fox = inspectGltf(fs.readFileSync(path.join(ASSETS, "third_party", "fox", "Fox.glb")), "Fox.glb");
  it("detects clips and sockets on a model the engine did not author", () => {
    expect(fox.clips.map((c) => c.name)).toEqual(["Survey", "Walk", "Run"]);
    expect(fox.rigged).toBe(true);
    expect(fox.sockets.head).toBeDefined();
    expect(fox.bounds!.size[1]).toBeGreaterThan(50); // centimetre-scale units: scale 0.01 in scenes
  });

  it.skipIf(!HAS_BLENDER)("renders and measures it at scene scale", async () => {
    const root = tmpDir("aefox-");
    const mgr = new WorkspaceManager({ root, libraries: { models: ASSETS } });
    const ws = mgr.create("fox");
    await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("models", "third_party/fox/Fox.glb"), origin: {} }, { assetId: "fox" });
    const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 96, height: 54, fps: 24 }, duration: 24 });
    await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { objects: [{ id: "fox", asset: "fox", clip: "Run", scale: { x: 0.01, y: 0.01, z: 0.01 } }], lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { render: { quality: "draft" }, camera: { position: { x: 2, y: 1, z: 2 }, lookAt: { object: "fox" } } }));
    const m = await ws.measure3D(sceneId, 5, { objects: ["fox"] });
    const size = m.objects[0].bounds.size;
    expect(size.y).toBeGreaterThan(0.4);
    expect(size.y).toBeLessThan(1.2);
    expect(m.objects[0].screen.fullyOnScreen).toBe(true);
    const pv = await ws.renderPreview(sceneId, 5);
    expect(pv.width).toBe(96);
  }, 120_000);
});
