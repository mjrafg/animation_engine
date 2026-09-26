/**
 * Joint continuity: skeleton-driven animation must keep characters visually connected.
 *
 *  - 3D: skin-weight analysis (blended / connected / rigid joints) on synthetic glTFs and on the
 *    shipped characters; render check (no notch at bent knees/elbows) when Blender is present.
 *  - 2D: joint-disk analysis on synthetic art (butt joint vs capsule joint) and on Pip; render
 *    checks at the frames of walk/run/wave/point where the joints bend most (joint rings at 90 %
 *    of the limb half-width and bone lines fully covered on a transparent background).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import * as ops from "../src/api/operations.js";
import * as ch from "../src/characters/operations.js";
import { analyzeJoints2D, type AlphaImage } from "../src/characters/continuity.js";
import { CharacterDefinitionSchema, type Character2D } from "../src/characters/schema.js";
import { blenderInfo } from "../src/scene3d/blender.js";
import { inspectGltf } from "../src/scene3d/gltf.js";
import * as ops3d from "../src/scene3d/operations.js";
import { WorkspaceManager, type VideoWorkspace } from "../src/workspace/workspace.js";
import { tmpDir } from "./helpers.js";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "assets", "characters");
const HAS_BLENDER = blenderInfo().available;
const FPS = 24;

// ---- synthetic glTF: two bones, two boxes -------------------------------------------------------

/** Two vertical quads (bone A below y=1, bone B above) with the given skinning of the joint row. */
function twoBoneGltf(mode: "rigid" | "connected" | "blended"): Buffer {
  // rigid: two separate quads (8 verts); connected/blended: one strip sharing the middle row
  const pos: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const idx: number[] = [];
  const v = (x: number, y: number, j0: number, w0: number, j1 = 0, w1 = 0) => {
    pos.push(x, y, 0);
    joints.push(j0, j1, 0, 0);
    weights.push(w0, w1, 0, 0);
    return pos.length / 3 - 1;
  };
  if (mode === "rigid") {
    const a = [v(0, 0, 0, 1), v(1, 0, 0, 1), v(1, 1, 0, 1), v(0, 1, 0, 1)];
    const b = [v(0, 1.01, 1, 1), v(1, 1.01, 1, 1), v(1, 2, 1, 1), v(0, 2, 1, 1)];
    for (const q of [a, b]) idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  } else {
    const r0 = [v(0, 0, 0, 1), v(1, 0, 0, 1)];
    const r1 = mode === "blended" ? [v(0, 1, 0, 0.5, 1, 0.5), v(1, 1, 0, 0.5, 1, 0.5)] : [v(0, 1, 0, 1), v(1, 1, 0, 1)];
    const r2 = [v(0, 2, 1, 1), v(1, 2, 1, 1)];
    for (const [a, b] of [[r0, r1], [r1, r2]]) idx.push(a[0], a[1], b[1], a[0], b[1], b[0]);
  }
  const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
  const u16 = (a: number[]) => {
    const b = Buffer.alloc(a.length * 2);
    a.forEach((x, i) => b.writeUInt16LE(x, i * 2));
    return b;
  };
  const u8 = (a: number[]) => Buffer.from(Uint8Array.from(a));
  const parts = [f32(pos), u8(joints), f32(weights), u16(idx)];
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const padded = parts.map(pad);
  const offsets = padded.reduce<number[]>((acc, b, i) => [...acc, i ? acc[i - 1] + padded[i - 1].length : 0], []);
  const bin = Buffer.concat(padded);
  const n = pos.length / 3;
  const ibm = [...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], ...[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]];
  const ibmBuf = f32(ibm);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, 2] }],
    nodes: [{ name: "boneA", children: [1] }, { name: "boneB", translation: [0, 1, 0] }, { name: "mesh", mesh: 0, skin: 0 }],
    skins: [{ joints: [0, 1], inverseBindMatrices: 4 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3 }] }],
    buffers: [{ byteLength: bin.length + ibmBuf.length }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: parts[0].length },
      { buffer: 0, byteOffset: offsets[1], byteLength: parts[1].length },
      { buffer: 0, byteOffset: offsets[2], byteLength: parts[2].length },
      { buffer: 0, byteOffset: offsets[3], byteLength: parts[3].length },
      { buffer: 0, byteOffset: bin.length, byteLength: ibmBuf.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: "VEC3", min: [0, 0, 0], max: [1, 2, 0] },
      { bufferView: 1, componentType: 5121, count: n, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count: n, type: "VEC4" },
      { bufferView: 3, componentType: 5123, count: idx.length, type: "SCALAR" },
      { bufferView: 4, componentType: 5126, count: 2, type: "MAT4" },
    ],
  };
  const all = Buffer.concat([bin, ibmBuf]);
  json.buffers[0] = { byteLength: all.length, uri: `data:application/octet-stream;base64,${all.toString("base64")}` } as any;
  return Buffer.from(JSON.stringify(json));
}

describe("3D skinning continuity analysis", () => {
  it("classifies joints as rigid, connected or blended from the real vertex data", () => {
    for (const mode of ["rigid", "connected", "blended"] as const) {
      const m = inspectGltf(twoBoneGltf(mode), `${mode}.gltf`);
      expect(m.skinning!.joints).toHaveLength(1);
      expect(m.skinning!.joints[0]).toMatchObject({ joint: "boneB", parent: "boneA", status: mode });
      expect(m.skinning!.continuous).toBe(mode !== "rigid");
    }
  });

  it("the shipped 3D characters are skinned with blended weights at every joint", () => {
    for (const f of [path.join(LIB, "mika", "mika.glb"), path.join(ROOT, "assets", "3d", "character.glb"), path.join(ROOT, "assets", "3d", "third_party", "fox", "Fox.glb")]) {
      const s = inspectGltf(fs.readFileSync(f), f).skinning!;
      expect(s.continuous, `${f}: ${s.rigidJoints}`).toBe(true);
      expect(s.joints.length).toBeGreaterThanOrEqual(12);
    }
    const mika = inspectGltf(fs.readFileSync(path.join(LIB, "mika", "mika.glb")), "mika.glb").skinning!;
    // every limb joint of the test character blends (shoulders, elbows, wrists, hips, knees, spine, neck, head)
    expect(mika.joints.every((j) => j.status === "blended")).toBe(true);
    expect(mika.maxInfluences).toBe(2);
  });
});

// ---- 2D -------------------------------------------------------------------------------------------

/** Alpha image drawn from a signed "inside" test in part-local units (1 px per unit). */
function alphaImage(w: number, h: number, inside: (x: number, y: number) => boolean): AlphaImage {
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = inside(x + 0.5, y + 0.5) ? 255 : 0;
  return { width: w, height: h, alpha };
}

function twoPartRig(shape: "butt" | "capsule", bend: number): Character2D {
  return CharacterDefinitionSchema.parse({
    id: "t",
    kind: "2d",
    assets: { upper: "u.png", lower: "l.png", body: "b.png" },
    rig: {
      parts: [
        { id: "body", asset: "body", x: 0, y: 0, anchorX: 0.5, anchorY: 0.5 },
        { id: "upper", asset: "upper", parent: "body", x: 0, y: 0, anchorX: 0.5, anchorY: 10 / 60 },
        { id: "lower", asset: "lower", parent: "upper", x: 0, y: 40, anchorX: 0.5, anchorY: 10 / 60 },
      ],
    },
    motions: { bend: { duration: 1, tracks: { "lower.rotation": [[0, 0], [0.5, bend]] } } },
  }) as Character2D;
}

describe("2D joint-disk continuity analysis", () => {
  const body = alphaImage(60, 60, () => true);
  // limb 20 wide, pivot at y=10, next joint at y=50 (40 below)
  const butt = alphaImage(20, 60, (x, y) => y >= 10 && y <= 50 && x > 2 && x < 18);
  const capsule = alphaImage(20, 60, (x, y) => {
    const cx = 10;
    if (y >= 10 && y <= 50) return Math.abs(x - cx) < 8;
    return Math.hypot(x - cx, y - (y < 10 ? 10 : 50)) < 8;
  });

  it("detects the wedge gap of butt joints and accepts capsule joints at any bend", () => {
    for (const bend of [30, 75, 120]) {
      const b = analyzeJoints2D(twoPartRig("butt", bend), (n) => (n === "body" ? body : butt));
      expect(b.joints.find((j) => j.part === "lower")!.status, `butt ${bend}`).toBe("gap");
      const c = analyzeJoints2D(twoPartRig("capsule", bend), (n) => (n === "body" ? body : capsule));
      expect(c.joints.find((j) => j.part === "lower")!.status, `capsule ${bend}`).toBe("continuous");
      expect(c.continuous).toBe(true);
    }
    // a joint that never rotates is not a continuity risk
    const s = analyzeJoints2D(twoPartRig("butt", 0), (n) => (n === "body" ? body : butt));
    expect(s.joints.find((j) => j.part === "lower")!.status).toBe("static");
  });

  it("pip: every moving joint (shoulders, elbows, hips, knees, ankles, waist, neck) is continuous", async () => {
    const def = CharacterDefinitionSchema.parse(JSON.parse(fs.readFileSync(path.join(LIB, "pip", "character.json"), "utf8"))) as Character2D;
    const imgs: Record<string, AlphaImage> = {};
    for (const [n, f] of Object.entries(def.assets)) {
      const { data, info } = await sharp(path.join(LIB, "pip", f)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
      imgs[n] = { width: info.width, height: info.height, alpha: new Uint8Array(data) };
    }
    const r = analyzeJoints2D(def, (n) => imgs[n]);
    expect(r.gaps).toEqual([]);
    const moving = r.joints.filter((j) => j.status !== "static").map((j) => j.part).sort();
    expect(moving).toEqual(["foot_l", "foot_r", "forearm_l", "forearm_r", "head", "shin_l", "shin_r", "thigh_l", "thigh_r", "torso", "upper_arm_l", "upper_arm_r"]);
    // the knees see the largest bend (run: 80 degrees) and still close completely
    expect(r.joints.find((j) => j.part === "shin_r")).toMatchObject({ angles: [0, 80], coverage: 1 });
    // every part has an explicit size (no part rendered at its 2x source resolution by accident)
    expect(def.rig.parts.filter((p) => p.asset && (p.width === undefined || p.height === undefined)).map((p) => p.id)).toEqual([]);
  });
});

// ---- workspace + renders --------------------------------------------------------------------------

async function prepared() {
  const mgr = new WorkspaceManager({ root: tmpDir("aecont-"), libraries: { characters: LIB } });
  const ws = mgr.create("w");
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  return { mgr, ws };
}

describe("production readiness", () => {
  it("is reported by character_inspect and warned about when a gappy character is placed", async () => {
    const { ws, mgr } = await prepared();
    const cont = ws.describeCharacter("pip").continuity as any;
    expect(cont).toMatchObject({ continuous: true, productionReady: true });
    // a copy of pip with a butt-jointed forearm (rectangle, no joint cap)
    const dir = tmpDir("gappy-");
    fs.cpSync(path.join(LIB, "pip"), dir, { recursive: true });
    const j = JSON.parse(fs.readFileSync(path.join(dir, "character.json"), "utf8"));
    // butt joint: a plain rectangle starting exactly at the elbow pivot row (no rounded joint cap)
    const { width, height } = (await sharp(path.join(dir, "parts", "forearm.png")).metadata()) as { width: number; height: number };
    const pivotRow = Math.round(j.rig.parts.find((p: any) => p.id === "forearm_r").anchorY * height);
    const rect = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: Math.round(width * 0.8), height: height - pivotRow - 4, channels: 4, background: "#f4c49d" } }, left: Math.round(width * 0.1), top: pivotRow }])
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(dir, "parts", "forearm.png"), rect);
    // ... and an upper arm that ends flat at the elbow (so neither side has a rounded cap)
    const ua = (await sharp(path.join(dir, "parts", "upper_arm.png")).metadata()) as { width: number; height: number };
    const uap = j.rig.parts.find((p: any) => p.id === "upper_arm_r");
    const top = Math.round(uap.anchorY * ua.height);
    const elbowRow = Math.round(top + (j.rig.parts.find((p: any) => p.id === "forearm_r").y / uap.height) * ua.height);
    const upper = await sharp({ create: { width: ua.width, height: ua.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: { create: { width: Math.round(ua.width * 0.7), height: elbowRow - top + 8, channels: 4, background: "#3a86c8" } }, left: Math.round(ua.width * 0.15), top: top - 8 }])
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(dir, "parts", "upper_arm.png"), upper);
    j.id = "gappy";
    fs.writeFileSync(path.join(dir, "character.json"), JSON.stringify(j));
    await ws.importCharacter(dir);
    const g = ws.describeCharacter("gappy").continuity as any;
    expect(g.productionReady).toBe(false);
    expect(g.gaps).toEqual(expect.arrayContaining(["forearm_l", "forearm_r"]));
    const { sceneId } = await ws.createScene({ canvas: { width: 320, height: 240, fps: FPS }, duration: 24 });
    const r = await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "g1", character: "gappy", x: 100, y: 220, scale: 0.5 }, ws.characterContext()));
    expect(r.warnings.map((w) => w.code)).toContain("CHARACTER_NOT_CONTINUOUS");
    const ok = await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "p1", character: "pip", x: 200, y: 220, scale: 0.5 }, ws.characterContext()));
    expect(ok.warnings.map((w) => w.code)).not.toContain("CHARACTER_NOT_CONTINUOUS");
    void mgr;
  });
});

type Rgba = { data: Buffer; width: number; height: number };
const alphaAt = (img: Rgba, x: number, y: number) => {
  const px = Math.round(x);
  const py = Math.round(y);
  return px < 0 || py < 0 || px >= img.width || py >= img.height ? 0 : img.data[(py * img.width + px) * 4 + 3];
};
async function rgba(file: string): Promise<Rgba> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const screenPivot = (l: any) => {
  const wb = l.worldBounds;
  const sb = l.screenBounds;
  const sx = (sb.right - sb.left) / Math.max(1e-6, wb.right - wb.left);
  const sy = (sb.bottom - sb.top) / Math.max(1e-6, wb.bottom - wb.top);
  return { x: sb.left + (l.worldPivot.x - wb.left) * sx, y: sb.top + (l.worldPivot.y - wb.top) * sy };
};
function trackAt(doc: any, target: string, prop: string, f: number) {
  const tr = doc.animations.find((a: any) => a.target === target && a.property === prop);
  if (!tr) return 0;
  let prev = tr.keyframes[0];
  for (const k of tr.keyframes) {
    if (k.frame > f) return prev.value + (k.value - prev.value) * ((f - prev.frame) / (k.frame - prev.frame));
    prev = k;
  }
  return prev.value;
}

async function stressScene(ws: VideoWorkspace) {
  const { sceneId } = await ws.createScene({ canvas: { width: 1400, height: 760, fps: FPS, background: "#00000000" }, duration: 8 * FPS });
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "p", character: "pip", x: 150, y: 720, scale: 2.2, autoBlink: false }, ws.characterContext()));
  await ws.mutateScene(sceneId, (d) =>
    ch.applyCharacterActions(d, "p", [
      { type: "add", action: { action: "walk", start: 0.3, duration: 1.2, direction: "right" } },
      { type: "add", action: { action: "run", start: 1.8, duration: 0.8, direction: "right" } },
      { type: "add", action: { action: "wave", start: 3.2, duration: 1.5 } },
      { type: "add", action: { action: "point", start: 5, duration: 1.2 } },
      { type: "add", action: { action: "look", direction: "up", start: 5, duration: 1.2 } },
    ], ws.characterContext()),
  );
  return sceneId;
}

describe("2D render stress: the body stays connected in the actual pixels", () => {
  it("walk, run, wave, point: joint rings (90 % of limb half-width) and bone lines are fully covered", async () => {
    const { ws } = await prepared();
    const sceneId = await stressScene(ws);
    const doc = ws.getSceneDoc(sceneId);
    const radii = Object.fromEntries(((ws.describeCharacter("pip").continuity as any).joints as any[]).filter((j) => j.status !== "static").map((j) => [j.part, j.radius]));
    const windows: [string, number, number, string[]][] = [
      ["walk", 0.6, 1.4, ["shin_r", "shin_l", "forearm_r"]],
      ["run", 2.0, 2.5, ["shin_r", "shin_l", "forearm_r", "forearm_l"]],
      ["wave", 3.5, 4.4, ["forearm_r", "upper_arm_r"]],
      ["point", 5.5, 6.0, ["upper_arm_r"]],
    ];
    for (const [name, a, b, watch] of windows) {
      let best = Math.round(a * FPS);
      let bestV = -1;
      for (let f = Math.round(a * FPS); f <= Math.round(b * FPS); f++) {
        const v = watch.reduce((s, p) => s + Math.abs(trackAt(doc, `p.${p}`, "rotation", f)), 0);
        if (v > bestV) (bestV = v), (best = f);
      }
      const rootX = trackAt(doc, "p", "x", best) || 150;
      await ws.mutateScene(sceneId, (d) => ops.setCamera(d, { x: rootX - 700 }));
      const img = await rgba(ws.abs((await ws.renderFrame(sceneId, best)).relativePath));
      const L = Object.fromEntries((await ws.measureLayout(sceneId, best)).layers.map((l) => [l.id, l]));
      for (const part of Object.keys(radii)) {
        const lay = L[`p.${part}`];
        const par = L[doc.layers.find((l: any) => l.id === `p.${part}`).parent];
        const c = screenPivot(lay);
        const r = 0.9 * radii[part] * 2.2;
        let ring = 0;
        for (let i = 0; i < 48; i++) if (alphaAt(img, c.x + r * Math.cos((i * Math.PI) / 24), c.y + r * Math.sin((i * Math.PI) / 24)) > 128) ring++;
        expect(ring, `${name} frame ${best}: ring at ${part}`).toBe(48);
        const pc = screenPivot(par);
        const n = Math.ceil(Math.hypot(c.x - pc.x, c.y - pc.y));
        for (let i = 0; i <= n; i++) expect(alphaAt(img, pc.x + ((c.x - pc.x) * i) / Math.max(1, n), pc.y + ((c.y - pc.y) * i) / Math.max(1, n)), `${name}: bone ${par.id}->${part}`).toBeGreaterThan(128);
      }
    }
  }, 60_000);
});

describe.skipIf(!HAS_BLENDER)("3D render stress", () => {
  it("run and wave: bent knees and elbows keep their outer side filled (no notch), bone lines covered", async () => {
    const { ws, mgr } = await prepared();
    await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"));
    const { sceneId } = await ws.createScene({ kind: "3d", canvas: { width: 320, height: 360, fps: FPS }, duration: 6 * FPS });
    await ws.mutateScene(sceneId, (d) => ops3d.addEntities3D(d, { lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { render: { quality: "draft", transparentBackground: true } }));
    await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "m", character: "mika", position: { x: 0, y: 0, z: 0 }, autoBlink: false }, ws.characterContext()));
    await ws.mutateScene(sceneId, (d) =>
      ch.applyCharacterActions(d, "m", [
        { type: "add", action: { action: "run", start: 0.2, duration: 1.4, direction: "right" } },
        { type: "add", action: { action: "turn", start: 1.8, direction: "camera" } },
        { type: "add", action: { action: "wave", start: 2.3, duration: 2 } },
      ], ws.characterContext()),
    );
    const joints = ws.getAsset("mika.model").model!.joints;
    const doc = ws.getSceneDoc(sceneId);
    for (const [f, view] of [[Math.round(1.1 * FPS), "side"], [Math.round(3.2 * FPS), "front"]] as const) {
      const x0 = trackAt(doc, "m", "position.x", f);
      const cam = view === "side" ? { position: { x: x0, y: 1.0, z: 3.6 }, lookAt: { x: x0, y: 0.95, z: 0 }, fov: 40 } : { position: { x: x0 + 1.5, y: 1.4, z: 2.8 }, lookAt: { x: x0, y: 1.2, z: 0 }, fov: 42 };
      await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: cam }));
      const img = await rgba(ws.abs((await ws.renderFrame(sceneId, f)).relativePath));
      const m = await ws.measure3D(sceneId, f, { objects: ["m"], bones: joints.map((j) => j.name) });
      const B = Object.fromEntries(Object.values((m.objects[0] as any).bones).map((b: any) => [b.bone, b]));
      for (const j of ["shin.L", "shin.R", "forearm.L", "forearm.R"]) {
        const a = B[joints.find((k) => k.name === j)!.parent!].screen;
        const b = B[j].screen;
        const c = B[j].tail.screen;
        const n1 = { x: a.x - b.x, y: a.y - b.y };
        const n2 = { x: c.x - b.x, y: c.y - b.y };
        const l1 = Math.hypot(n1.x, n1.y);
        const l2 = Math.hypot(n2.x, n2.y);
        const bis = { x: n1.x / l1 + n2.x / l2, y: n1.y / l1 + n2.y / l2 };
        const bl = Math.hypot(bis.x, bis.y);
        const reach = (d: { x: number; y: number }) => {
          let r = 0;
          while (r < 200 && alphaAt(img, b.x + d.x * (r + 1), b.y + d.y * (r + 1)) > 128) r++;
          return r;
        };
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const perp = { x: -n1.y / l1, y: n1.x / l1 };
        const hwAt = (p: { x: number; y: number }, d: { x: number; y: number }) => {
          let r = 0;
          while (r < 200 && alphaAt(img, p.x + d.x * (r + 1), p.y + d.y * (r + 1)) > 128) r++;
          return r;
        };
        const hw = Math.min(hwAt(mid, perp), hwAt(mid, { x: -perp.x, y: -perp.y }));
        if (hw < 3) continue; // limb seen end-on
        const depth = bl < 0.2 ? Math.min(reach(perp), reach({ x: -perp.x, y: -perp.y })) : reach({ x: -bis.x / bl, y: -bis.y / bl });
        expect(depth / hw, `${view} frame ${f}: outer depth at ${j}`).toBeGreaterThanOrEqual(0.5);
      }
      for (const j of joints) {
        if (!j.parent || j.parent === "root" || j.name === "hips" || !B[j.name] || !B[j.parent]) continue;
        if (j.parent === "spine" && /upper_arm/.test(j.name)) continue; // torso->shoulder is not a limb line
        const a = B[j.parent].screen;
        const b = B[j.name].screen;
        const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
        let ok = 0;
        for (let i = 0; i <= n; i++) if (alphaAt(img, a.x + ((b.x - a.x) * i) / Math.max(1, n), a.y + ((b.y - a.y) * i) / Math.max(1, n)) > 128) ok++;
        expect(ok / (n + 1), `${view} frame ${f}: bone ${j.parent}->${j.name}`).toBeGreaterThanOrEqual(0.99);
      }
    }
  }, 180_000);
});
