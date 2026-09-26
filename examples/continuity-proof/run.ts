/**
 * Joint-continuity stress proof for the prepared characters (2D Pip, 3D Mika).
 *
 *   npx tsx examples/continuity-proof/run.ts <label>        (label: before | after)
 *
 * Drives each character through walk, run, wave and point with the character runtime (no
 * keyframes), picks the frames where the joints bend the most, renders them on a TRANSPARENT
 * background (character only) and checks the actual pixels:
 *   - bone lines: every sampled point between consecutive joints must be covered (no detached
 *     segment),
 *   - joint rings (2D): a ring around each moving joint, at 70 % of the limb half-width, must be
 *     covered (no wedge gap at elbows/knees/ankles/shoulders/hips/neck/waist),
 * plus the engine's static analysis (2D joint-disk coverage; 3D skin weights). Writes contact
 * sheets with joint zooms to docs/character-continuity/<label>/ and a report.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import * as ops from "../../src/api/operations.js";
import * as ch from "../../src/characters/operations.js";
import { blenderInfo } from "../../src/scene3d/blender.js";
import * as ops3d from "../../src/scene3d/operations.js";
import { WorkspaceManager, type VideoWorkspace } from "../../src/workspace/workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const LABEL = process.argv[2] ?? "after";
const LIB = process.argv.includes("--lib") ? path.resolve(process.argv[process.argv.indexOf("--lib") + 1]) : path.join(ROOT, "assets", "characters");
const OUT = path.join(ROOT, "docs", "character-continuity", LABEL);
const FPS = 24;
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? "  " + JSON.stringify(detail) : ""}`);
};

type Rgba = { data: Buffer; width: number; height: number };
const alphaAt = (img: Rgba, x: number, y: number) => {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
  return img.data[(py * img.width + px) * 4 + 3];
};
async function rgbaOf(file: string): Promise<Rgba> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
function segmentCoverage(img: Rgba, a: { x: number; y: number }, b: { x: number; y: number }) {
  const n = Math.max(4, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  let ok = 0;
  for (let i = 0; i <= n; i++) if (alphaAt(img, a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n) > 128) ok++;
  return ok / (n + 1);
}
/** Opaque half-width of a limb at point p, perpendicular to direction d (screen px). */
function halfWidth(img: Rgba, p: { x: number; y: number }, d: { x: number; y: number }) {
  const len = Math.hypot(d.x, d.y) || 1;
  const nx = -d.y / len;
  const ny = d.x / len;
  const side = (s: number) => {
    let r = 0;
    while (r < 200 && alphaAt(img, p.x + s * nx * (r + 1), p.y + s * ny * (r + 1)) > 128) r++;
    return r;
  };
  return Math.min(side(1), side(-1));
}
const norm = (v: { x: number; y: number }) => {
  const l = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / l, y: v.y / l };
};
/** Opaque distance from p along direction d (screen px). */
function reach(img: Rgba, p: { x: number; y: number }, d: { x: number; y: number }) {
  let r = 0;
  while (r < 300 && alphaAt(img, p.x + d.x * (r + 1), p.y + d.y * (r + 1)) > 128) r++;
  return r;
}
function ringCoverage(img: Rgba, c: { x: number; y: number }, r: number) {
  let ok = 0;
  const n = 48;
  for (let i = 0; i < n; i++) if (alphaAt(img, c.x + r * Math.cos((2 * Math.PI * i) / n), c.y + r * Math.sin((2 * Math.PI * i) / n)) > 128) ok++;
  return ok / n;
}

const esc = (t: string) => t.replace(/[<>&]/g, "");
const label = (w: number, text: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="26"><rect width="${w}" height="26" fill="#222"/><text x="8" y="18" fill="#fff" font-size="15" font-family="sans-serif">${esc(text)}</text></svg>`);

/** One sheet row per stress frame: the full frame + zooms of the listed joints. */
async function sheet(rows: { title: string; file: string; zooms: { name: string; x: number; y: number }[] }[], out: string, full: number, zoomSrc: number, zoom: number) {
  const tiles: OverlayOptions[] = [];
  const width = full + 4 * zoom;
  let y = 0;
  for (const r of rows) {
    tiles.push({ input: label(width, r.title), left: 0, top: y });
    y += 26;
    const bg = { r: 236, g: 240, b: 245, alpha: 1 };
    const flat = await sharp(r.file).flatten({ background: bg }).png().toBuffer();
    const meta = await sharp(flat).metadata();
    const fullImg = await sharp(flat).resize(full).png().toBuffer();
    tiles.push({ input: fullImg, left: 0, top: y });
    const fh = Math.round((meta.height! * full) / meta.width!);
    const zs = r.zooms.slice(0, 4);
    for (const [i, z] of zs.entries()) {
      const left = Math.max(0, Math.min(meta.width! - zoomSrc, Math.round(z.x - zoomSrc / 2)));
      const top = Math.max(0, Math.min(meta.height! - zoomSrc, Math.round(z.y - zoomSrc / 2)));
      const crop = await sharp(flat).extract({ left, top, width: zoomSrc, height: zoomSrc }).resize(zoom, zoom, { kernel: "nearest" }).png().toBuffer();
      tiles.push({ input: crop, left: full + i * zoom, top: y });
      tiles.push({ input: label(zoom, z.name), left: full + i * zoom, top: y + zoom - 26 });
    }
    y += Math.max(fh, zoom) + 6;
  }
  await sharp({ create: { width, height: y, channels: 3, background: "#111" } }).composite(tiles).jpeg({ quality: 88 }).toFile(out);
}

function trackValue(doc: any, target: string, prop: string, frame: number) {
  const tr = doc.animations.find((a: any) => a.target === target && a.property === prop);
  if (!tr) return doc.layers?.find((l: any) => l.id === target)?.[prop] ?? 0;
  let v = tr.keyframes[0].value;
  let prev = tr.keyframes[0];
  for (const k of tr.keyframes) {
    if (k.frame <= frame) (v = k.value), (prev = k);
    else {
      const t = (frame - prev.frame) / (k.frame - prev.frame);
      return typeof v === "number" ? v + (k.value - v) * t : v;
    }
  }
  return v;
}

const STRESS = [
  { name: "walk", action: { action: "walk", start: 0.3, duration: 1.6, direction: "right" }, window: [0.8, 1.8], metric: ["shin_r", "shin_l", "forearm_r", "forearm_l"] },
  { name: "run", action: { action: "run", start: 2.2, duration: 1.5, direction: "right" }, window: [2.7, 3.6], metric: ["shin_r", "shin_l", "forearm_r", "forearm_l"] },
  { name: "wave", action: { action: "wave", start: 4.2, duration: 1.8 }, window: [4.7, 5.8], metric: ["forearm_r", "upper_arm_r"] },
  { name: "point", action: { action: "point", start: 6.4, duration: 1.4 }, window: [7.0, 7.6], metric: ["upper_arm_r"] },
];

async function run2D(ws: VideoWorkspace) {
  const summary: Record<string, unknown> = {};
  const cont = ws.describeCharacter("pip").continuity as any;
  summary.analysis = cont;
  check("2D engine analysis: every moving joint continuous", !!cont?.continuous, cont?.gaps);
  const { sceneId } = await ws.createScene({ sceneId: "pip_stress", canvas: { width: 900, height: 760, fps: FPS, background: "#00000000" }, duration: 8 * FPS });
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "p", character: "pip", x: 330, y: 720, scale: 2.2, autoBlink: false }, ws.characterContext()));
  await ws.mutateScene(sceneId, (d) =>
    ch.applyCharacterActions(d, "p", [...STRESS.map((s) => ({ type: "add", action: s.action })), { type: "add", action: { action: "look", direction: "up", start: 6.4, duration: 1.4 } }, { type: "add", action: { action: "smile", start: 6.4, duration: 1.4 } }], ws.characterContext()),
  );
  // keep the character in frame: position the stress frames by resetting x via a static camera pan is not needed;
  // the run/walk move it right, so render with a camera that follows the root
  const doc = ws.getSceneDoc(sceneId);
  const rows: Parameters<typeof sheet>[0] = [];
  const pixel: Record<string, unknown>[] = [];
  const jointParts = (doc.layers as any[]).filter((l) => l.meta?.character === "p" && l.parent && l.parent !== "p").map((l) => l.meta.part as string);
  const radii = Object.fromEntries(((cont?.joints ?? []) as any[]).map((j) => [j.part, j.radius]));
  const statuses = Object.fromEntries(((cont?.joints ?? []) as any[]).map((j) => [j.part, j.status]));
  for (const s of STRESS) {
    // frame where the watched joints bend most
    let best = Math.round(s.window[0] * FPS);
    let bestV = -1;
    for (let f = Math.round(s.window[0] * FPS); f <= Math.round(s.window[1] * FPS); f++) {
      const v = s.metric.reduce((acc, p) => acc + Math.abs(trackValue(doc, `p.${p}`, "rotation", f)), 0);
      if (v > bestV) (bestV = v), (best = f);
    }
    // follow the character with the camera so it stays centred
    const rootX = trackValue(doc, "p", "x", best);
    await ws.mutateScene(sceneId, (d) => ops.setCamera(d, { x: rootX - 450 + 30 }));
    const fr = await ws.renderFrame(sceneId, best);
    const file = ws.abs(fr.relativePath);
    const img = await rgbaOf(file);
    const layout = await ws.measureLayout(sceneId, best);
    const L = Object.fromEntries(layout.layers.map((l) => [l.id, l]));
    const piv = (part: string) => L[`p.${part}`]?.screenBounds && { x: L[`p.${part}`].worldPivot.x - (rootX - 420), y: L[`p.${part}`].worldPivot.y };
    let worstRing = 1;
    let worstSeg = 1;
    const perJoint: Record<string, { ring: number; bone: number }> = {};
    for (const part of jointParts) {
      if (statuses[part] === "static" || statuses[part] === undefined) continue;
      const lay = L[`p.${part}`];
      const par = L[(doc.layers as any[]).find((l) => l.id === `p.${part}`).parent];
      if (!lay || !par) continue;
      // screen positions come from the layout (camera applied): use screenBounds-consistent pivots
      const c = layoutScreen(lay);
      const pc = layoutScreen(par);
      const ring = ringCoverage(img, c, 0.9 * (radii[part] ?? 5) * 2.2);
      const bone = segmentCoverage(img, pc, c);
      perJoint[part] = { ring: +ring.toFixed(3), bone: +bone.toFixed(3) };
      worstRing = Math.min(worstRing, ring);
      worstSeg = Math.min(worstSeg, bone);
    }
    void piv;
    pixel.push({ stress: s.name, frame: best, worstRing: +worstRing.toFixed(3), worstBone: +worstSeg.toFixed(3), joints: perJoint });
    check(`2D ${s.name} (frame ${best}): joint rings and bone lines fully covered in the render`, worstRing >= 0.999 && worstSeg >= 0.999, { worstRing: +worstRing.toFixed(3), worstBone: +worstSeg.toFixed(3) });
    const z = (part: string, name: string) => ({ name, ...layoutScreen(L[`p.${part}`]) });
    const zooms =
      s.name === "wave" || s.name === "point"
        ? [z("upper_arm_r", "shoulder"), z("forearm_r", "elbow"), z("hand_r", "wrist"), z("head", "neck")]
        : [z("shin_r", "knee (near)"), z("shin_l", "knee (far)"), z("forearm_r", "elbow"), z("foot_r", "ankle")];
    rows.push({ title: `2D Pip — ${s.name}, frame ${best} (${LABEL})`, file, zooms });
  }
  await sheet(rows, path.join(OUT, "pip_2d_stress.jpg"), 460, 110, 230);
  summary.pixelChecks = pixel;
  return summary;
}

/** Screen position of a layer's pivot (the layout's worldPivot mapped through the camera like screenBounds). */
function layoutScreen(l: any) {
  const wb = l.worldBounds;
  const sb = l.screenBounds;
  const sx = (sb.right - sb.left) / Math.max(1e-6, wb.right - wb.left);
  const sy = (sb.bottom - sb.top) / Math.max(1e-6, wb.bottom - wb.top);
  return { x: sb.left + (l.worldPivot.x - wb.left) * sx, y: sb.top + (l.worldPivot.y - wb.top) * sy };
}

async function run3D(ws: VideoWorkspace, mgr: WorkspaceManager) {
  const summary: Record<string, unknown> = {};
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "mika"), { replace: true });
  const cont = ws.describeCharacter("mika").continuity as any;
  summary.analysis = cont;
  check("3D engine analysis: skin weights keep every joint continuous", !!cont?.continuous, cont?.rigidJoints);
  const { sceneId } = await ws.createScene({ sceneId: "mika_stress", kind: "3d", canvas: { width: 640, height: 720, fps: FPS }, duration: 8 * FPS });
  await ws.mutateScene(sceneId, (d) =>
    ops3d.addEntities3D(d, { lights: [{ id: "key", type: "sun", intensity: 2.6, rotation: { x: -40, y: 50, z: 0 } }, { id: "fill", type: "sun", intensity: 1.2, rotation: { x: -20, y: -60, z: 0 }, shadows: false }] }),
  );
  await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { render: { quality: "standard", transparentBackground: true }, world: { color: "#d8dde4", strength: 0.8 } }));
  await ws.mutateScene(sceneId, (d) => ch.addCharacter(d, { id: "m", character: "mika", position: { x: 0, y: 0, z: 0 }, autoBlink: false }, ws.characterContext()));
  // 3D gestures are full-body clips: sequential schedule; walking/running along +x
  await ws.mutateScene(sceneId, (d) =>
    ch.applyCharacterActions(d, "m", [
      { type: "add", action: { action: "walk", start: 0.3, duration: 1.6, direction: "right" } },
      { type: "add", action: { action: "run", start: 2.2, duration: 1.5, direction: "right" } },
      { type: "add", action: { action: "turn", start: 3.8, direction: "camera" } },
      { type: "add", action: { action: "wave", start: 4.2, duration: 1.8 } },
      { type: "add", action: { action: "point", start: 6.4, duration: 1.4 } },
    ], ws.characterContext()),
  );
  const model = ws.getAsset("mika.model").model!;
  const joints = model.joints.map((j) => j.name);
  const frames: [string, number, "side" | "front"][] = [
    ["walk", Math.round(1.3 * FPS), "side"],
    ["run", Math.round(3.1 * FPS), "side"],
    ["wave", Math.round(5.0 * FPS), "front"],
    ["point", Math.round(7.2 * FPS), "side"],
  ];
  const rows: Parameters<typeof sheet>[0] = [];
  const pixel: Record<string, unknown>[] = [];
  for (const [name, f, view] of frames) {
    const doc = ws.getSceneDoc(sceneId);
    const x = trackValue({ ...doc, layers: [] }, "m", "position.x", f);
    // side views see elbows/knees in profile (where rigid parts open up); front view for the wave
    const cam = view === "side" ? { position: { x: x, y: 1.05, z: 3.4 }, lookAt: { x: x, y: 0.95, z: 0 }, fov: 42 } : { position: { x: x + 1.6, y: 1.4, z: 2.8 }, lookAt: { x: x, y: 1.2, z: 0 }, fov: 42 };
    await ws.mutateScene(sceneId, (d) => ops3d.setSettings3D(d, { camera: cam }));
    const fr = await ws.renderFrame(sceneId, f);
    const file = ws.abs(fr.relativePath);
    const img = await rgbaOf(file);
    const m = await ws.measure3D(sceneId, f, { objects: ["m"], bones: joints });
    const bones = (m.objects[0] as any).bones as Record<string, { bone: string; screen: { x: number; y: number }; tail?: { screen: { x: number; y: number } } }>;
    const byJoint = Object.fromEntries(Object.values(bones).map((b) => [b.bone, b.screen]));
    const tails = Object.fromEntries(Object.values(bones).map((b: any) => [b.bone, b.tail?.screen]));
    let worst = 1;
    let worstRing = 1;
    const perBone: Record<string, number> = {};
    const rings: Record<string, number> = {};
    for (const j of model.joints) {
      if (!j.parent || !byJoint[j.name] || !byJoint[j.parent] || j.parent === "root" || j.name === "root") continue;
      if (j.name === "hips") continue; // root -> hips is not a body segment
      const a = byJoint[j.parent];
      const b = byJoint[j.name];
      const cov = segmentCoverage(img, a, b);
      perBone[`${j.parent}->${j.name}`] = +cov.toFixed(3);
      worst = Math.min(worst, cov);
      // bending joints (elbows, knees, wrists): NOTCH DEPTH on the outside of the bend, relative
      // to the limb's half-width. A rigid-part joint opens a V notch reaching (almost) to the joint
      // centre (depth ~0); a skinned joint stays filled (it may thin a little, it does not open).
      if (/(forearm|shin|hand)/.test(j.name)) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const hw = halfWidth(img, mid, { x: b.x - a.x, y: b.y - a.y });
        const next = model.joints.find((k) => k.parent === j.name);
        const c = next && byJoint[next.name] ? byJoint[next.name] : tails[j.name];
        if (hw >= 3 && c) {
          const u1 = norm({ x: a.x - b.x, y: a.y - b.y });
          const u2 = norm({ x: c.x - b.x, y: c.y - b.y });
          const bis = { x: u1.x + u2.x, y: u1.y + u2.y };
          const dirs = Math.hypot(bis.x, bis.y) < 0.2 ? [{ x: -u1.y, y: u1.x }, { x: u1.y, y: -u1.x }] : [norm({ x: -bis.x, y: -bis.y })];
          const depth = Math.min(...dirs.map((d) => reach(img, b, d)));
          const ratio = depth / hw;
          rings[j.name] = +ratio.toFixed(3);
          worstRing = Math.min(worstRing, ratio);
        }
      }
    }
    pixel.push({ stress: name, frame: f, worstBone: +worst.toFixed(3), minNotchDepth: +worstRing.toFixed(3), bones: perBone, notchDepth: rings });
    check(`3D ${name} (frame ${f}): bone lines covered, no joint notch (outer depth >= 0.5 of limb half-width)`, worst >= 0.98 && worstRing >= 0.5, { worstBone: +worst.toFixed(3), minNotchDepth: +worstRing.toFixed(3) });
    const zj = (joint: string, label: string) => ({ name: label, ...byJoint[joint] });
    const zooms = name === "wave" || name === "point" ? [zj("upper_arm.R", "shoulder"), zj("forearm.R", "elbow"), zj("hand.R", "wrist"), zj("neck", "neck")] : [zj("shin.R", "knee"), zj("shin.L", "knee"), zj("forearm.R", "elbow"), zj("thigh.R", "hip")];
    rows.push({ title: `3D Mika — ${name}, frame ${f}, ${view} view (${LABEL})`, file, zooms });
  }
  await sheet(rows, path.join(OUT, "mika_3d_stress.jpg"), 360, 150, 205);
  summary.pixelChecks = pixel;
  return summary;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const root = path.join(ROOT, "out", "continuity-ws");
  fs.rmSync(root, { recursive: true, force: true });
  const mgr = new WorkspaceManager({ root, libraries: { characters: LIB } });
  const ws = mgr.create("c");
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  const report: Record<string, unknown> = { label: LABEL };
  report.pip2d = await run2D(ws);
  if (blenderInfo().available) report.mika3d = await run3D(ws, mgr);
  report.checks = checks;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${LABEL}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed -> ${path.relative(ROOT, OUT)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
