/**
 * glTF 2.0 / GLB inspection in pure TypeScript (no Blender needed).
 *
 * Used to validate imported 3D assets and to describe them to agents and to the scene validator:
 * animation clips (name, duration), skeleton joints and their hierarchy, semantic sockets
 * (rightHand, head, root, ...), morph targets (face shapes), meshes and bind-pose bounds.
 *
 * Units and axes are glTF's: metres, right-handed, +Y up, a model's front faces +Z.
 */
import { EngineError } from "../errors.js";
import { analyzeSkinning, type SkinningReport } from "./skinning.js";

export interface GltfClip {
  name: string;
  /** Seconds from the clip's first to last key. */
  duration: number;
  /** Time of the first key (usually 0). */
  start: number;
  channels: number;
  /** Which kinds of properties the clip animates. */
  animates: string[];
}

export interface GltfJoint {
  name: string;
  parent: string | null;
}

export interface GltfMorph {
  mesh: string;
  targets: string[];
}

export interface ModelInfo {
  format: "glb" | "gltf";
  generator: string | null;
  meshes: { name: string; primitives: number; vertices: number; morphTargets: string[] }[];
  vertices: number;
  materials: number;
  textures: number;
  /** All animation clips, by name. */
  clips: GltfClip[];
  /** True when the asset has a skin (a rigged mesh). */
  rigged: boolean;
  joints: GltfJoint[];
  /** Semantic socket name -> joint name, detected from joint names (e.g. rightHand -> "hand.R"). */
  sockets: Record<string, string>;
  /** Unique morph target (shape key) names across meshes. */
  morphTargets: string[];
  morphs: GltfMorph[];
  /** Approximate bind-pose axis-aligned bounds in metres (glTF space, Y up). */
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] } | null;
  nodes: number;
  cameras: number;
  lights: number;
  /** Rigged models: skin weights per joint (blended / connected / rigid) and overall continuity. */
  skinning?: SkinningReport | null;
}

type Json = Record<string, any>;

const bad = (msg: string, details: Record<string, unknown> = {}) => new EngineError("INVALID_ASSET", `Invalid glTF: ${msg}`, details);

/** Parses GLB or .gltf bytes. .gltf must be self-contained (data: URIs only). */
export function readGltfJson(data: Buffer, filename = ""): { json: Json; format: "glb" | "gltf" } {
  if (data.length >= 12 && data.readUInt32LE(0) === 0x46546c67) {
    const version = data.readUInt32LE(4);
    const length = data.readUInt32LE(8);
    if (version !== 2) throw bad(`GLB version ${version} is not supported (need 2)`);
    if (length > data.length) throw bad("GLB is truncated", { declared: length, actual: data.length });
    const chunkLen = data.readUInt32LE(12);
    const chunkType = data.readUInt32LE(16);
    if (chunkType !== 0x4e4f534a) throw bad("first GLB chunk is not JSON");
    if (20 + chunkLen > data.length) throw bad("GLB JSON chunk is truncated");
    try {
      return { json: JSON.parse(data.subarray(20, 20 + chunkLen).toString("utf8")), format: "glb" };
    } catch {
      throw bad("GLB JSON chunk is not valid JSON");
    }
  }
  let json: Json;
  try {
    json = JSON.parse(data.toString("utf8"));
  } catch {
    throw bad(`${filename || "file"} is neither a GLB nor glTF JSON`);
  }
  for (const b of json.buffers ?? []) {
    if (b.uri && !String(b.uri).startsWith("data:")) {
      throw bad("a .gltf with external buffer files is not supported; export as .glb (single file)", { uri: b.uri });
    }
  }
  for (const im of json.images ?? []) {
    if (im.uri && !String(im.uri).startsWith("data:")) {
      throw bad("a .gltf with external texture files is not supported; export as .glb (single file)", { uri: im.uri });
    }
  }
  return { json, format: "gltf" };
}

// ---- small 4x4 column-major matrix helpers (glTF convention) -----------------------------------

type M4 = number[];
const I4: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function trs(n: Json): M4 {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  for (let i = 0; i < 3; i++) {
    r[i] *= sx;
    r[4 + i] *= sy;
    r[8 + i] *= sz;
  }
  r[12] = tx;
  r[13] = ty;
  r[14] = tz;
  return r;
}
const apply = (m: M4, p: number[]) => [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);

// ---- semantic sockets ---------------------------------------------------------------------------

const FINGERS = /(thumb|index|middle|ring|pinky|little|finger)/;

function side(name: string): "left" | "right" | null {
  const n = name.toLowerCase();
  if (/(^|[^a-z])(left|l)([^a-z]|$)/.test(n) || /^left|left(?=[a-z])/.test(n) || /[._-]l$/.test(n)) return "left";
  if (/(^|[^a-z])(right|r)([^a-z]|$)/.test(n) || /^right|right(?=[a-z])/.test(n) || /[._-]r$/.test(n)) return "right";
  return null;
}

/** Maps joint names to semantic sockets (rightHand, leftHand, head, neck, spine, hips, root, feet, forearms, upper arms). */
export function detectSockets(joints: GltfJoint[]): Record<string, string> {
  const out: Record<string, string> = {};
  const clean = (n: string) => n.toLowerCase().replace(/^mixamorig\d*[:_]?/, "").replace(/^(armature|rig|skeleton)[:_|]/, "");
  const pick = (key: string, test: (c: string, raw: string) => boolean) => {
    const cands = joints.filter((j) => test(clean(j.name), j.name)).sort((a, b) => a.name.length - b.name.length);
    if (cands.length && !out[key]) out[key] = cands[0].name;
  };
  for (const s of ["left", "right"] as const) {
    const S = s === "left" ? "left" : "right";
    pick(`${S}Hand`, (c, raw) => /hand|wrist/.test(c) && !FINGERS.test(c) && side(raw) === s);
    pick(`${S}Forearm`, (c, raw) => /(fore ?arm|lowerarm|lower_arm|elbow)/.test(c) && side(raw) === s);
    pick(`${S}UpperArm`, (c, raw) => /(upper ?arm|upperarm|upper_arm|^arm|[^e]arm$|shoulder)/.test(c) && !/(fore|lower)/.test(c) && side(raw) === s);
    pick(`${S}Foot`, (c, raw) => /(foot|ankle)/.test(c) && !/toe/.test(c) && side(raw) === s);
    pick(`${S}UpperLeg`, (c, raw) => /(thigh|upperleg|upper_leg|upleg)/.test(c) && side(raw) === s);
  }
  pick("head", (c) => /head/.test(c) && !/(end|top|nub)/.test(c));
  pick("neck", (c) => /neck/.test(c));
  pick("chest", (c) => /(chest|spine2|spine_02|upperchest)/.test(c));
  pick("spine", (c) => /spine/.test(c));
  pick("hips", (c) => /(hips|pelvis)/.test(c));
  const roots = joints.filter((j) => j.parent === null);
  if (roots.length) out.root = roots[0].name;
  return out;
}

// ---- main ----------------------------------------------------------------------------------------

export function inspectGltf(data: Buffer, filename = ""): ModelInfo {
  const { json, format } = readGltfJson(data, filename);
  const ver = String(json.asset?.version ?? "");
  if (!ver.startsWith("2")) throw bad(`asset.version "${ver}" is not 2.x`);
  const nodes: Json[] = json.nodes ?? [];
  const accessors: Json[] = json.accessors ?? [];
  const acc = (i: unknown) => {
    const a = typeof i === "number" ? accessors[i] : undefined;
    if (!a) throw bad(`accessor ${String(i)} does not exist`);
    return a;
  };
  const nodeName = (i: number) => nodes[i]?.name ?? `node_${i}`;

  // parents
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) =>
    (n.children ?? []).forEach((c: number) => {
      if (!nodes[c]) throw bad(`node ${i} has missing child ${c}`);
      parentOf.set(c, i);
    }),
  );
  const worldCache = new Map<number, M4>();
  const world = (i: number, depth = 0): M4 => {
    if (depth > 256) throw bad("node hierarchy has a cycle");
    const c = worldCache.get(i);
    if (c) return c;
    const p = parentOf.get(i);
    const m = p === undefined ? trs(nodes[i]) : mul(world(p, depth + 1), trs(nodes[i]));
    worldCache.set(i, m);
    return m;
  };

  // meshes + morphs
  const meshes = (json.meshes ?? []).map((m: Json, mi: number) => {
    let vertices = 0;
    let targetCount = 0;
    for (const p of m.primitives ?? []) {
      if (p.attributes?.POSITION === undefined) throw bad(`mesh ${mi} primitive has no POSITION`);
      vertices += acc(p.attributes.POSITION).count ?? 0;
      targetCount = Math.max(targetCount, (p.targets ?? []).length);
    }
    const names: string[] = Array.isArray(m.extras?.targetNames) ? m.extras.targetNames.map(String) : [];
    const morphTargets = Array.from({ length: targetCount }, (_, i) => names[i] ?? `morph_${i}`);
    return { name: m.name ?? `mesh_${mi}`, primitives: (m.primitives ?? []).length, vertices, morphTargets };
  });

  // skins / joints
  const jointIdx = new Set<number>();
  for (const s of json.skins ?? []) for (const j of s.joints ?? []) {
    if (!nodes[j]) throw bad(`skin references missing joint node ${j}`);
    jointIdx.add(j);
  }
  const joints: GltfJoint[] = [...jointIdx].sort((a, b) => a - b).map((j) => {
    let p = parentOf.get(j);
    while (p !== undefined && !jointIdx.has(p)) p = parentOf.get(p);
    return { name: nodeName(j), parent: p === undefined ? null : nodeName(p) };
  });

  // clips
  const clips: GltfClip[] = (json.animations ?? []).map((a: Json, ai: number) => {
    let start = Infinity;
    let end = -Infinity;
    for (const s of a.samplers ?? []) {
      const inp = acc(s.input);
      const mn = Array.isArray(inp.min) ? inp.min[0] : 0;
      const mx = Array.isArray(inp.max) ? inp.max[0] : 0;
      start = Math.min(start, mn);
      end = Math.max(end, mx);
    }
    if (!Number.isFinite(start)) start = end = 0;
    return {
      name: a.name ?? `animation_${ai}`,
      duration: +(end - start).toFixed(4),
      start: +start.toFixed(4),
      channels: (a.channels ?? []).length,
      animates: [...new Set((a.channels ?? []).map((c: Json) => String(c.target?.path)))].sort() as string[],
    };
  });
  const dupe = clips.find((c, i) => clips.findIndex((d) => d.name === c.name) !== i);
  if (dupe) throw bad(`two animation clips are both named "${dupe.name}"`);

  // bind-pose bounds from POSITION min/max of mesh nodes
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const mesh = (json.meshes ?? [])[n.mesh];
    if (!mesh) throw bad(`node ${i} references missing mesh ${n.mesh}`);
    const m = n.skin !== undefined ? I4 : world(i); // skinned meshes are placed by their joints; use mesh space
    for (const p of mesh.primitives ?? []) {
      const a = acc(p.attributes.POSITION);
      if (!Array.isArray(a.min) || !Array.isArray(a.max)) continue;
      for (const x of [a.min[0], a.max[0]]) for (const y of [a.min[1], a.max[1]]) for (const z of [a.min[2], a.max[2]]) {
        const w = apply(m, [x, y, z]);
        min = min.map((v, k) => Math.min(v, w[k]));
        max = max.map((v, k) => Math.max(v, w[k]));
      }
    }
  });
  const r3 = (v: number) => +v.toFixed(4);
  const bounds = Number.isFinite(min[0])
    ? { min: min.map(r3) as [number, number, number], max: max.map(r3) as [number, number, number], size: max.map((v, k) => r3(v - min[k])) as [number, number, number] }
    : null;

  const morphs = meshes.filter((m: any) => m.morphTargets.length).map((m: any) => ({ mesh: m.name, targets: m.morphTargets }));
  return {
    format,
    generator: json.asset?.generator ?? null,
    meshes,
    vertices: meshes.reduce((s: number, m: any) => s + m.vertices, 0),
    materials: (json.materials ?? []).length,
    textures: (json.textures ?? []).length,
    clips,
    rigged: (json.skins ?? []).length > 0,
    joints,
    sockets: detectSockets(joints),
    morphTargets: [...new Set<string>(morphs.flatMap((m: GltfMorph) => m.targets))],
    morphs,
    bounds,
    nodes: nodes.length,
    cameras: (json.cameras ?? []).length,
    lights: (json.extensions?.KHR_lights_punctual?.lights ?? []).length,
    skinning: (json.skins ?? []).length ? safeSkinning(data, json, joints) : null,
  };
}

function safeSkinning(data: Buffer, json: Json, joints: GltfJoint[]): SkinningReport | null {
  try {
    return analyzeSkinning(data, json, joints);
  } catch {
    return null; // unusual encodings (sparse accessors): no report rather than a failed import
  }
}
