/**
 * Skinning / joint-continuity analysis of a rigged glTF model (pure TypeScript, reads the binary
 * vertex data: JOINTS_n / WEIGHTS_n and the triangle indices).
 *
 * For every joint that moves geometry, relative to its nearest ancestor joint that also moves
 * geometry, the joint is classified:
 *  - "blended":   some vertices are weighted to BOTH bones (smooth skinning across the joint);
 *  - "connected": no shared weights, but triangles connect vertices of both bones (one continuous
 *                 surface; it stretches instead of tearing);
 *  - "rigid":     separate pieces (each 100% on its bone): bending the joint can open a visible gap.
 * A model is continuous when no joint is rigid. Linear-blend skinning never tears a connected
 * surface, so "blended"/"connected" joints stay visually attached in every pose.
 */
import type { GltfJoint } from "./gltf.js";

type Json = Record<string, any>;

export interface JointContinuity {
  joint: string;
  parent: string;
  status: "blended" | "connected" | "rigid";
  blendedVertices: number;
  sharedEdges: number;
}

export interface SkinningReport {
  skinnedPrimitives: number;
  /** Mesh nodes in a rigged model that are not skinned (they move only with their node). */
  unskinnedMeshes: number;
  vertices: number;
  maxInfluences: number;
  joints: JointContinuity[];
  rigidJoints: string[];
  continuous: boolean;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const READ: Record<number, [number, (b: Buffer, o: number) => number]> = {
  5120: [1, (b, o) => b.readInt8(o)],
  5121: [1, (b, o) => b.readUInt8(o)],
  5122: [2, (b, o) => b.readInt16LE(o)],
  5123: [2, (b, o) => b.readUInt16LE(o)],
  5125: [4, (b, o) => b.readUInt32LE(o)],
  5126: [4, (b, o) => b.readFloatLE(o)],
};

function buffers(data: Buffer, json: Json): Buffer[] {
  let bin: Buffer | null = null;
  if (data.length >= 12 && data.readUInt32LE(0) === 0x46546c67) {
    const jl = data.readUInt32LE(12);
    const off = 20 + jl;
    if (off + 8 <= data.length && data.readUInt32LE(off + 4) === 0x004e4942) bin = data.subarray(off + 8, off + 8 + data.readUInt32LE(off));
  }
  return (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri?.startsWith("data:")) return Buffer.from(b.uri.slice(b.uri.indexOf(",") + 1), "base64");
    if (i === 0 && bin) return bin;
    throw new Error(`buffer ${i} unavailable`);
  });
}

function reader(data: Buffer, json: Json) {
  const bufs = buffers(data, json);
  return (index: number): number[][] => {
    const a = json.accessors[index];
    if (!a || a.bufferView === undefined || a.sparse) throw new Error(`accessor ${index} unsupported`);
    const bv = json.bufferViews[a.bufferView];
    const [size, rd] = READ[a.componentType];
    const n = COMPONENTS[a.type];
    const stride = bv.byteStride || size * n;
    const buf = bufs[bv.buffer];
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const norm = a.normalized ? { 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[a.componentType as 5121] ?? 1 : 1;
    const out: number[][] = [];
    for (let i = 0; i < a.count; i++) {
      const v: number[] = [];
      for (let k = 0; k < n; k++) v.push(rd(buf, base + i * stride + k * size) / norm);
      out.push(v);
    }
    return out;
  };
}

export function analyzeSkinning(data: Buffer, json: Json, joints: GltfJoint[]): SkinningReport | null {
  const nodes: Json[] = json.nodes ?? [];
  if (!(json.skins ?? []).length) return null;
  const read = reader(data, json);
  const name = (i: number) => nodes[i]?.name ?? `node_${i}`;
  const parentOf = new Map(joints.map((j) => [j.name, j.parent]));
  // per bone: dominant vertices; per pair: shared weights / edges
  const dominantCount = new Map<string, number>();
  const blended = new Map<string, number>();
  const edges = new Map<string, number>();
  const key = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  let skinnedPrimitives = 0;
  let unskinned = 0;
  let vertices = 0;
  let maxInfluences = 0;
  nodes.forEach((n) => {
    if (n.mesh === undefined) return;
    const mesh = json.meshes[n.mesh];
    if (n.skin === undefined) {
      unskinned++;
      return;
    }
    const skinJoints: number[] = json.skins[n.skin].joints;
    for (const prim of mesh.primitives ?? []) {
      const at = prim.attributes ?? {};
      if (at.JOINTS_0 === undefined || at.WEIGHTS_0 === undefined) continue;
      skinnedPrimitives++;
      const sets: [number[][], number[][]][] = [[read(at.JOINTS_0), read(at.WEIGHTS_0)]];
      if (at.JOINTS_1 !== undefined && at.WEIGHTS_1 !== undefined) sets.push([read(at.JOINTS_1), read(at.WEIGHTS_1)]);
      const count = sets[0][0].length;
      vertices += count;
      const dom: string[] = new Array(count);
      for (let v = 0; v < count; v++) {
        const infl = new Map<string, number>();
        for (const [J, W] of sets) for (let k = 0; k < 4; k++) if (W[v][k] > 0) infl.set(name(skinJoints[J[v][k]]), (infl.get(name(skinJoints[J[v][k]])) ?? 0) + W[v][k]);
        const total = [...infl.values()].reduce((s, w) => s + w, 0) || 1;
        const sig = [...infl.entries()].filter(([, w]) => w / total > 0.05).sort((a, b) => b[1] - a[1]);
        maxInfluences = Math.max(maxInfluences, sig.length);
        dom[v] = sig[0]?.[0] ?? "";
        dominantCount.set(dom[v], (dominantCount.get(dom[v]) ?? 0) + 1);
        for (let i = 0; i < sig.length; i++) for (let j = i + 1; j < sig.length; j++) blended.set(key(sig[i][0], sig[j][0]), (blended.get(key(sig[i][0], sig[j][0])) ?? 0) + 1);
      }
      if ((prim.mode ?? 4) !== 4) continue;
      const idx = prim.indices !== undefined ? read(prim.indices).map((x) => x[0]) : Array.from({ length: count }, (_, i) => i);
      for (let t = 0; t + 2 < idx.length; t += 3) {
        for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
          if (dom[a] !== dom[b]) edges.set(key(dom[a], dom[b]), (edges.get(key(dom[a], dom[b])) ?? 0) + 1);
        }
      }
    }
  });
  const moves = (j: string) => (dominantCount.get(j) ?? 0) > 0;
  const out: JointContinuity[] = [];
  for (const j of joints) {
    if (!moves(j.name)) continue;
    let p = parentOf.get(j.name) ?? null;
    while (p && !moves(p)) p = parentOf.get(p) ?? null;
    if (!p) continue;
    // shared weights with the parent or any bone in between (a chain through weightless joints)
    const b = blended.get(key(j.name, p)) ?? 0;
    const e = edges.get(key(j.name, p)) ?? 0;
    out.push({ joint: j.name, parent: p, status: b > 0 ? "blended" : e > 0 ? "connected" : "rigid", blendedVertices: b, sharedEdges: e });
  }
  const rigid = out.filter((x) => x.status === "rigid").map((x) => x.joint);
  return { skinnedPrimitives, unskinnedMeshes: unskinned, vertices, maxInfluences, joints: out, rigidJoints: rigid, continuous: rigid.length === 0 && skinnedPrimitives > 0 };
}
