/**
 * Plan -> canonical scene content. The runtime evaluates the composed character pose at every
 * frame (motions, blends, gesture overrides, expressions, visemes, blinks, facing, root path) and
 * writes the result as ordinary layers (2D) / objects (3D) and keyframe tracks, reduced to the
 * keys needed to reproduce the curve (linear segments within a small tolerance; step keys for
 * discrete values). Everything generated carries `owner = <instance id>` (tracks, audio) or
 * `meta.character = <instance id>` (layers/objects), so recompiling replaces exactly it.
 *
 * Deterministic: pure functions of (definition, instance, fps, duration, saved speech timings).
 */
import { apply, compose, identity, invert, multiply, rotateDeg, scale as scaleM, translate, type Mat2D } from "../math/matrix.js";
import type { Character2D, Character3D, CharacterInstance, Motion } from "./schema.js";
import { facingAt, positionAt, weightAt, type Plan } from "./plan.js";
import { resolveViseme } from "./speech.js";

export interface CompiledTrack {
  target: string;
  property: string;
  owner: string;
  keyframes: { frame: number; value: number | string | boolean; interpolation?: "step" | "linear" }[];
}

export interface CompiledCharacter {
  layers?: Record<string, unknown>[];
  objects?: Record<string, unknown>[];
  tracks: CompiledTrack[];
  audio: { asset: string; startFrame: number; volume?: number }[];
  /** 2D: world (canvas) matrix of a part's pivot frame at a frame, after all motions and IK. */
  fk?: (part: string, frame: number) => Mat2D;
}

/**
 * An arm driven toward per-frame targets (from interactions). The runtime solves a two-bone IK
 * (upper, lower) so the end's grip point reaches the target, blended with the animated pose by
 * weight. 2D: parts, grip = the socket's attachment point. 3D: joint names, grip = distance (m)
 * from the wrist joint to the palm along the hand.
 */
export interface ReachDrive {
  hand: "right" | "left";
  upper: string;
  lower: string;
  end: string;
  point?: string;
  grip?: number;
  /** Per frame (length = scene frames): weight 0..1 and world target (2D px: x, y; 3D m). */
  weights: number[];
  targets: { x: number; y: number; z: number }[];
  /** 2D: hand art (asset name) while reaching (weight >= 0.5). */
  handPose?: string;
}

export interface CompileExtras {
  reaches?: ReachDrive[];
  /** Prop id -> frame from which the prop is hidden (handed to another character). */
  hideProps?: Record<string, number>;
}

type Part2D = Character2D["rig"]["parts"][number];

/** Offset of a part's parentPoint in its parent's pivot frame (0,0 without parentPoint). */
export function partPointOffset(def: Character2D, part: Part2D): { x: number; y: number } {
  if (!part.parent || !part.parentPoint) return { x: 0, y: 0 };
  const par = def.rig.parts.find((p) => p.id === part.parent);
  const pt = par?.attachmentPoints?.[part.parentPoint];
  if (!par || !pt) return { x: 0, y: 0 };
  return { x: (pt.x - par.anchorX) * (par.width ?? 0), y: (pt.y - par.anchorY) * (par.height ?? 0) };
}

/** A named attachment point of a part in its own pivot frame (0,0 = pivot). */
export function pointInPart(part: Part2D, point: string | undefined): { x: number; y: number } {
  const pt = point ? part.attachmentPoints?.[point] : undefined;
  if (!pt) return { x: 0, y: 0 };
  return { x: (pt.x - part.anchorX) * (part.width ?? 0), y: (pt.y - part.anchorY) * (part.height ?? 0) };
}

/** Angle (deg) that rotates the +y axis onto v (the engine's rotation convention, y down). */
const angleOf = (v: { x: number; y: number }) => (Math.atan2(-v.x, v.y) * 180) / Math.PI;
const rot2 = (v: { x: number; y: number }, deg: number) => {
  const r = (deg * Math.PI) / 180;
  return { x: v.x * Math.cos(r) - v.y * Math.sin(r), y: v.x * Math.sin(r) + v.y * Math.cos(r) };
};
const wrapDeg = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/**
 * Analytic two-bone IK in the upper bone's parent frame. O = shoulder, v1 = upper bone vector
 * (to the elbow) and v2 = lower bone vector (elbow to grip) in their own unrotated frames.
 * Returns the upper and lower local rotations placing the grip on T (or as close as the arm
 * reaches), elbow bent toward +y (down) of the parent frame, and the remaining miss.
 */
export function solveTwoBone2D(O: { x: number; y: number }, v1: { x: number; y: number }, v2: { x: number; y: number }, T: { x: number; y: number }) {
  const L1 = Math.hypot(v1.x, v1.y);
  const L2 = Math.hypot(v2.x, v2.y);
  const dx = T.x - O.x;
  const dy = T.y - O.y;
  const dist = Math.hypot(dx, dy);
  const d = Math.max(Math.abs(L1 - L2) + 1e-6, Math.min(L1 + L2 - 1e-6, dist));
  const u = dist > 1e-9 ? { x: dx / dist, y: dy / dist } : { x: 0, y: 1 };
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const n = { x: -u.y, y: u.x };
  const e1 = { x: O.x + a * u.x + h * n.x, y: O.y + a * u.y + h * n.y };
  const e2 = { x: O.x + a * u.x - h * n.x, y: O.y + a * u.y - h * n.y };
  const E = e1.y >= e2.y ? e1 : e2;
  const W = { x: O.x + u.x * d, y: O.y + u.y * d };
  const upper = angleOf({ x: E.x - O.x, y: E.y - O.y }) - angleOf(v1);
  const lower = angleOf({ x: W.x - E.x, y: W.y - E.y }) - angleOf(v2) - upper;
  return { upper, lower, miss: Math.max(0, dist - (L1 + L2)) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Minimal linear keys reproducing `vals` within `eps`. */
export function reduceLinear(vals: number[], eps: number): { frame: number; value: number }[] {
  const n = vals.length;
  if (n === 0) return [];
  const keys = [0];
  let anchor = 0;
  for (let i = 2; i < n; i++) {
    let ok = true;
    for (let k = anchor + 1; k < i; k++) {
      const t = (k - anchor) / (i - anchor);
      if (Math.abs(vals[anchor] + (vals[i] - vals[anchor]) * t - vals[k]) > eps) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      keys.push(i - 1);
      anchor = i - 1;
    }
  }
  if (n > 1) keys.push(n - 1);
  return keys.map((f) => ({ frame: f, value: r3(vals[f]) }));
}

function stepKeys<T extends string | boolean | number>(vals: T[]): { frame: number; value: T; interpolation: "step" }[] {
  const out: { frame: number; value: T; interpolation: "step" }[] = [];
  vals.forEach((v, f) => {
    if (!out.length || out[out.length - 1].value !== v) out.push({ frame: f, value: v, interpolation: "step" });
  });
  return out;
}

/** Value of a motion track (offset) at motion time t (seconds). */
export function motionValue(m: Motion, keys: [number, number][], t: number): number {
  if (keys.length === 1) return keys[0][1];
  const d = m.duration;
  let ks = keys;
  let tt: number;
  if (m.loop) {
    tt = ((t % d) + d) % d;
    ks = [...keys, [keys[0][0] + d, keys[0][1]]];
    if (tt < ks[0][0]) tt += d;
  } else {
    tt = Math.min(Math.max(t, 0), d);
    if (tt <= ks[0][0]) return ks[0][1];
    if (tt >= ks[ks.length - 1][0]) return ks[ks.length - 1][1];
  }
  for (let i = 0; i + 1 < ks.length; i++) {
    const [t0, v0] = ks[i];
    const [t1, v1] = ks[i + 1];
    if (tt >= t0 && tt <= t1) {
      const u = t1 > t0 ? (tt - t0) / (t1 - t0) : 1;
      const e = m.interpolation === "smooth" ? u * u * (3 - 2 * u) : u;
      return v0 + (v1 - v0) * e;
    }
  }
  return ks[ks.length - 1][1];
}

function emitNumeric(tracks: CompiledTrack[], statics: Record<string, number>, owner: string, target: string, prop: string, vals: number[], eps: number) {
  const first = vals[0];
  if (vals.every((v) => Math.abs(v - first) <= eps / 4)) {
    statics[prop] = r3(first);
    return;
  }
  statics[prop] = r3(first);
  tracks.push({ target, property: prop, owner, keyframes: reduceLinear(vals, eps) });
}

function emitDiscrete<T extends string | boolean>(tracks: CompiledTrack[], statics: Record<string, unknown>, owner: string, target: string, prop: string, vals: T[]) {
  const keys = stepKeys(vals);
  statics[prop] = vals[0];
  if (keys.length > 1) tracks.push({ target, property: prop, owner, keyframes: keys });
}

// ================================================================================================
// 2D

export interface Compile2DContext {
  /** Asset name in the definition -> workspace asset id. */
  assetId: (name: string) => string;
}

export function compile2D(plan: Plan, def: Character2D, inst: CharacterInstance, ctx: Compile2DContext, extras: CompileExtras = {}): CompiledCharacter {
  const owner = inst.id;
  const N = plan.frames;
  const fps = plan.fps;
  const scale = inst.scale ?? 1;
  const baseZ = inst.z ?? 10;
  const lid = (part: string) => `${owner}.${part}`;
  const tracks: CompiledTrack[] = [];
  const layers: Record<string, unknown>[] = [];
  const B = plan.blendFrames;
  const rigSign = def.rig.facing === "right" ? 1 : -1;
  const idleMotion = def.motions.idle;

  // --- root
  const rootStatics: Record<string, number> = {};
  const xs: number[] = [];
  const ys: number[] = [];
  const sx: number[] = [];
  for (let f = 0; f < N; f++) {
    const p = positionAt(plan, f);
    xs.push(p.x);
    ys.push(p.y);
    sx.push(scale * facingAt(plan, f) * rigSign);
  }
  emitNumeric(tracks, rootStatics, owner, owner, "x", xs, 0.05);
  emitNumeric(tracks, rootStatics, owner, owner, "y", ys, 0.05);
  emitNumeric(tracks, rootStatics, owner, owner, "scaleX", sx, 0.004);
  layers.push({ id: owner, ...rootStatics, scaleY: scale, z: baseZ, meta: { character: owner, generated: true, part: "root" } });

  // --- which part properties are driven
  const driven = new Map<string, Set<string>>(); // part -> props
  const addDriven = (key: string) => {
    const i = key.lastIndexOf(".");
    const part = key.slice(0, i);
    if (!driven.has(part)) driven.set(part, new Set());
    driven.get(part)!.add(key.slice(i + 1));
  };
  for (const m of Object.values(def.motions)) for (const k of Object.keys(m.tracks)) addDriven(k);
  for (const e of Object.values(def.expressions)) for (const [part, o] of Object.entries(e.parts)) for (const prop of ["x", "y", "rotation"] as const) if (o[prop] !== undefined) addDriven(`${part}.${prop}`);

  const motionOffset = (name: string | undefined, key: string, t: number) => {
    const m = name ? def.motions[name] : undefined;
    const keys = m?.tracks[key];
    return m && keys ? motionValue(m, keys as [number, number][], t) : 0;
  };

  // per frame: base (locomotion + idle) weights
  const baseMixAt = (f: number): { motion?: string; w: number; t: number }[] => {
    const out: { motion?: string; w: number; t: number }[] = [];
    let sum = 0;
    for (const s of plan.locomotion) {
      const w = weightAt(s, f, B);
      if (w > 0) {
        out.push({ motion: s.motion ?? (s.type === "idle" ? "idle" : undefined), w, t: (f - s.f0) / fps });
        sum += w;
      }
    }
    if (idleMotion && sum < 1) out.push({ motion: "idle", w: 1 - sum, t: f / fps });
    return out;
  };
  const mixes = Array.from({ length: N }, (_, f) => baseMixAt(f));
  const baseMix = (f: number) => mixes[f];
  const gestureAt = (part: string, f: number) => {
    for (const g of plan.gestures) {
      if (!g.claims.includes(part)) continue;
      const m = g.motion ? def.motions[g.motion] : undefined;
      const b = m?.blend !== undefined ? Math.max(1, Math.round(m.blend * fps)) : B;
      const w = weightAt(g, f, b);
      if (w > 0) return { g, w, t: (f - g.f0) / fps, m };
    }
    return null;
  };
  const exprAt = (f: number) => {
    for (const e of plan.expressions) {
      const w = weightAt(e, f, B) * e.intensity;
      if (w > 0) return { e, w };
    }
    return null;
  };

  // --- part values per frame (motions, gestures, expressions), then IK, then emit
  const PROPS = ["x", "y", "rotation", "scaleX", "scaleY", "opacity"] as const;
  const values = new Map<string, Record<string, number[] | number>>();
  for (const part of def.rig.parts) {
    const rest: Record<string, number> = { x: part.x, y: part.y, rotation: part.rotation, scaleX: part.scaleX, scaleY: part.scaleY, opacity: part.opacity };
    const props = driven.get(part.id) ?? new Set<string>();
    const rec: Record<string, number[] | number> = {};
    for (const prop of PROPS) {
      if (!props.has(prop)) {
        rec[prop] = rest[prop];
        continue;
      }
      const key = `${part.id}.${prop}`;
      const vals: number[] = [];
      for (let f = 0; f < N; f++) {
        let base = 0;
        for (const b of baseMix(f)) base += b.w * motionOffset(b.motion, key, b.t);
        const g = gestureAt(part.id, f);
        let off = g ? (1 - g.w) * base + g.w * motionOffset(g.g.motion, key, g.t) : base;
        const e = exprAt(f);
        const eo = e ? (def.expressions[e.e.name]?.parts[part.id] as Record<string, number | undefined> | undefined)?.[prop] : undefined;
        if (e && eo !== undefined) off += e.w * eo;
        vals.push(rest[prop] + off);
      }
      rec[prop] = vals;
    }
    values.set(part.id, rec);
  }
  const val = (part: string, prop: string, f: number) => {
    const v = values.get(part)![prop];
    return typeof v === "number" ? v : v[f];
  };
  const arrayOf = (part: string, prop: string): number[] => {
    const rec = values.get(part)!;
    const v = rec[prop];
    if (typeof v !== "number") return v;
    const arr = new Array<number>(N).fill(v);
    rec[prop] = arr;
    return arr;
  };
  const partById = new Map(def.rig.parts.map((p) => [p.id, p]));
  const offsets = new Map(def.rig.parts.map((p) => [p.id, partPointOffset(def, p)]));
  const localM = (id: string, f: number): Mat2D => {
    const o = offsets.get(id)!;
    return compose(translate(o.x + val(id, "x", f), o.y + val(id, "y", f)), rotateDeg(val(id, "rotation", f)), scaleM(val(id, "scaleX", f), val(id, "scaleY", f)));
  };
  const fkLocal = (id: string | null | undefined, f: number): Mat2D => {
    const chain: string[] = [];
    for (let cur = id; cur; cur = partById.get(cur)?.parent ?? null) chain.unshift(cur);
    return chain.reduce((m, c) => multiply(m, localM(c, f)), identity());
  };
  const rootM = (f: number) => compose(translate(xs[f], ys[f]), scaleM(sx[f], scale));

  // reach IK: upper/lower rotations so the end part's grip point meets the target
  const reaches = extras.reaches ?? [];
  for (const r of reaches) {
    const up = partById.get(r.upper);
    const lo = partById.get(r.lower);
    const en = partById.get(r.end);
    if (!up || !lo || !en) continue;
    const gOff = pointInPart(en, r.point);
    const upRot = arrayOf(up.id, "rotation");
    const loRot = arrayOf(lo.id, "rotation");
    for (let f = 0; f < N; f++) {
      const w = r.weights[f] ?? 0;
      if (w <= 0) continue;
      const R = rootM(f);
      if (Math.abs(R.a * R.d - R.b * R.c) < 1e-6) continue; // mid-flip
      const inv = invert(multiply(R, fkLocal(up.parent, f)));
      if (!inv) continue;
      const Tl = apply(inv, { x: r.targets[f].x, y: r.targets[f].y });
      const oU = offsets.get(up.id)!;
      const O = { x: oU.x + val(up.id, "x", f), y: oU.y + val(up.id, "y", f) };
      const su = val(up.id, "scaleX", f);
      const sl = val(lo.id, "scaleX", f);
      const oL = offsets.get(lo.id)!;
      const v1 = { x: su * (oL.x + val(lo.id, "x", f)), y: su * (oL.y + val(lo.id, "y", f)) };
      const oE = offsets.get(en.id)!;
      const g = rot2({ x: gOff.x * val(en.id, "scaleX", f), y: gOff.y * val(en.id, "scaleY", f) }, val(en.id, "rotation", f));
      const v2 = { x: su * sl * (oE.x + val(en.id, "x", f) + g.x), y: su * sl * (oE.y + val(en.id, "y", f) + g.y) };
      const sol = solveTwoBone2D(O, v1, v2, Tl);
      upRot[f] = upRot[f] + w * wrapDeg(sol.upper - upRot[f]);
      loRot[f] = loRot[f] + w * wrapDeg(sol.lower - loRot[f]);
    }
  }
  const poseAt = (part: string, f: number): string | undefined => {
    for (const r of reaches) if (r.end === part && r.handPose && (r.weights[f] ?? 0) >= 0.5 && def.assets[r.handPose]) return r.handPose;
    return undefined;
  };

  // --- parts
  for (const part of def.rig.parts) {
    const id = lid(part.id);
    const statics: Record<string, unknown> = {
      id,
      parent: part.parent ? lid(part.parent) : owner,
      ...(part.parentPoint ? { parentPoint: part.parentPoint } : {}),
      ...(part.fill ? { fill: part.fill } : {}),
      ...(part.width !== undefined ? { width: part.width } : {}),
      ...(part.height !== undefined ? { height: part.height } : {}),
      anchorX: part.anchorX,
      anchorY: part.anchorY,
      z: r3(baseZ + part.z / 100),
      ...(part.attachmentPoints ? { attachmentPoints: part.attachmentPoints } : {}),
      meta: { character: owner, generated: true, part: part.id },
    };
    const numStatics: Record<string, number> = {};
    for (const prop of PROPS) {
      const v = values.get(part.id)![prop];
      if (typeof v === "number") {
        numStatics[prop] = v;
        continue;
      }
      emitNumeric(tracks, numStatics, owner, id, prop, v, prop.startsWith("scale") || prop === "opacity" ? 0.004 : 0.08);
    }
    Object.assign(statics, numStatics);
    if (part.opacity === 1) delete statics.opacity;

    // discrete asset
    if (part.asset !== undefined || def.mouth?.part === part.id || def.eyes?.part === part.id) {
      const assets: string[] = [];
      for (let f = 0; f < N; f++) assets.push(ctx.assetId(poseAt(part.id, f) ?? partAssetAt(def, plan, part.id, part.asset, f, gestureAt, exprAt)));
      emitDiscrete(tracks, statics, owner, id, "asset", assets);
    }
    if (!part.visible) statics.visible = false;
    layers.push(statics);
  }

  // --- props
  const audio: CompiledCharacter["audio"] = [];
  for (const prop of inst.props ?? []) {
    const sock = def.sockets[prop.socket];
    const part = sock ? def.rig.parts.find((p) => p.id === sock.part) : undefined;
    const id = lid(prop.id);
    const layer: Record<string, unknown> = {
      id,
      asset: prop.asset,
      parent: lid(sock!.part),
      ...(sock!.point ? { parentPoint: sock!.point } : {}),
      x: prop.x ?? 0,
      y: prop.y ?? 0,
      rotation: prop.rotation ?? 0,
      ...(prop.scale ? { scaleX: prop.scale, scaleY: prop.scale } : {}),
      z: r3(baseZ + ((part?.z ?? 0) + (prop.z ?? 0.5)) / 100),
      meta: { character: owner, generated: true, prop: prop.id, socket: prop.socket },
    };
    const hide = extras.hideProps?.[prop.id];
    if (prop.visibleFrom !== undefined || prop.visibleUntil !== undefined || hide !== undefined) {
      const a = Math.round((prop.visibleFrom ?? 0) * fps);
      const b = Math.min(prop.visibleUntil !== undefined ? Math.round(prop.visibleUntil * fps) : Infinity, hide ?? Infinity);
      emitDiscrete(tracks, layer, owner, id, "visible", Array.from({ length: N }, (_, f) => f >= a && f < b));
    }
    layers.push(layer);
  }
  for (const s of plan.speech) if (s.audio) audio.push({ asset: s.audio.asset, startFrame: s.f0, ...(s.audio.volume !== undefined ? { volume: s.audio.volume } : {}) });
  return { layers, tracks, audio, fk: (part, f) => multiply(rootM(f), fkLocal(part, f)) };
}

function partAssetAt(
  def: Character2D,
  plan: Plan,
  partId: string,
  restAsset: string | undefined,
  f: number,
  gestureAt: (part: string, f: number) => { g: { motion?: string }; w: number } | null,
  exprAt: (f: number) => { e: { name: string }; w: number } | null,
): string {
  const e = exprAt(f);
  const exprDef = e && e.w >= 0.5 ? def.expressions[e.e.name] : undefined;
  if (def.eyes?.part === partId && plan.blinks.some((b) => f >= b.f0 && f < b.f1)) return def.eyes.closed;
  if (def.mouth?.part === partId) {
    const sets = def.mouth.sets;
    const set = { ...(sets.neutral ?? {}), ...(exprDef?.mouthSet ? sets[exprDef.mouthSet] ?? {} : {}) };
    const sp = plan.speech.find((s) => f >= s.f0 && f < s.f1);
    const v = sp?.visemes.find((x) => f >= x.f0 && f < x.f1)?.viseme ?? "rest";
    return resolveViseme(set, v) ?? restAsset ?? "";
  }
  const g = gestureAt(partId, f);
  if (g && g.w >= 0.5) {
    const a = g.g.motion ? def.motions[g.g.motion]?.assets?.[partId] : undefined;
    if (a) return a;
  }
  const ea = exprDef?.parts[partId]?.asset;
  if (ea) return ea;
  if (def.eyes?.part === partId) return def.eyes.open;
  // locomotion asset swaps (e.g. a running hand pose)
  for (const s of plan.locomotion) {
    if (f >= s.f0 && f < s.f1 && s.motion) {
      const a = def.motions[s.motion]?.assets?.[partId];
      if (a) return a;
    }
  }
  return restAsset ?? "";
}

// ================================================================================================
// 3D

export interface Compile3DContext {
  modelAsset: string;
  /** Idle clip to play when nothing else does (null: rest pose). */
  idleClip: string | null;
}

export function compile3D(plan: Plan, def: Character3D, inst: CharacterInstance, ctx: Compile3DContext, extras: CompileExtras = {}): CompiledCharacter {
  const owner = inst.id;
  const N = plan.frames;
  const tracks: CompiledTrack[] = [];
  const s = (inst.scale ?? 1) * def.scale;
  const obj: Record<string, unknown> = {
    id: owner,
    asset: ctx.modelAsset,
    scale: { x: s, y: s, z: s },
    clipBlend: def.blendFrames,
    meta: { character: owner, generated: true },
  };
  const statics: Record<string, number> = {};
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const yaw: number[] = [];
  for (let f = 0; f < N; f++) {
    const p = positionAt(plan, f);
    px.push(p.x);
    py.push(p.y);
    pz.push(p.z);
    yaw.push(facingAt(plan, f));
  }
  emitNumeric(tracks, statics, owner, owner, "position.x", px, 0.002);
  emitNumeric(tracks, statics, owner, owner, "position.y", py, 0.002);
  emitNumeric(tracks, statics, owner, owner, "position.z", pz, 0.002);
  emitNumeric(tracks, statics, owner, owner, "rotation.y", yaw, 0.2);
  obj.position = { x: statics["position.x"], y: statics["position.y"], z: statics["position.z"] };
  obj.rotation = { x: 0, y: statics["rotation.y"], z: 0 };

  // clip per frame: gesture > locomotion > idle
  const clips: string[] = [];
  for (let f = 0; f < N; f++) {
    const g = plan.gestures.find((x) => f >= x.f0 && f < x.f1);
    const l = plan.locomotion.find((x) => f >= x.f0 && f < x.f1);
    clips.push(g?.clip ?? l?.clip ?? ctx.idleClip ?? "");
  }
  const clipStatics: Record<string, unknown> = {};
  emitDiscrete(tracks, clipStatics, owner, owner, "clip", clips);
  if (clipStatics.clip) obj.clip = clipStatics.clip;

  // morph targets: expression + visemes + blinks (additive, clamped)
  const names = new Set<string>();
  for (const e of Object.values(def.expressions)) for (const k of Object.keys(e.morphs)) names.add(k);
  for (const set of Object.values(def.mouth?.sets ?? {})) for (const w of Object.values(set)) for (const k of Object.keys(w ?? {})) names.add(k);
  for (const k of Object.keys(def.eyes?.blink ?? {})) names.add(k);
  const visemeWeights = (f: number): Record<string, number> => {
    const sp = plan.speech.find((x) => f >= x.f0 && f < x.f1);
    if (!sp || !def.mouth) return {};
    const e = plan.expressions.find((x) => f >= x.f0 && f < x.f1);
    const set = { ...(def.mouth.sets.neutral ?? {}), ...(e ? def.mouth.sets[e.name] ?? {} : {}) };
    const v = sp.visemes.find((x) => f >= x.f0 && f < x.f1)?.viseme ?? "rest";
    const w = resolveViseme(set, v) ?? {};
    return Object.fromEntries(Object.entries(w).map(([k, x]) => [k, x * sp.intensity]));
  };
  const morphMorph: Record<string, number[]> = {};
  for (const n of names) morphMorph[n] = [];
  for (let f = 0; f < N; f++) {
    const acc: Record<string, number> = {};
    const add = (k: string, v: number) => (acc[k] = (acc[k] ?? 0) + v);
    for (const e of plan.expressions) {
      const w = weightAt(e, f, plan.blendFrames) * e.intensity;
      if (w > 0) for (const [k, v] of Object.entries(def.expressions[e.name]?.morphs ?? {})) add(k, w * v);
    }
    // visemes: average of this and the previous frame's target (a 2-frame crossfade)
    const a = visemeWeights(f);
    const b = f > 0 ? visemeWeights(f - 1) : a;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) add(k, ((a[k] ?? 0) + (b[k] ?? 0)) / 2);
    for (const bl of plan.blinks) {
      if (f < bl.f0 || f >= bl.f1) continue;
      const t = (f - bl.f0 + 0.5) / (bl.f1 - bl.f0);
      const w = 1 - Math.abs(2 * t - 1);
      for (const [k, v] of Object.entries(def.eyes?.blink ?? {})) add(k, Math.min(1, w * 1.6) * v);
    }
    for (const n of names) morphMorph[n].push(Math.min(1, Math.max(0, acc[n] ?? 0)));
  }
  const morphStatics: Record<string, number> = {};
  for (const n of [...names].sort()) emitNumeric(tracks, morphStatics, owner, owner, `morph.${n}`, morphMorph[n], 0.01);
  const staticMorphs = Object.fromEntries(Object.entries(morphStatics).filter(([, v]) => v > 0).map(([k, v]) => [k.slice(6), v]));
  if (Object.keys(staticMorphs).length) obj.morphs = staticMorphs;

  // reach IK chains (interactions): weight + world target tracks; the backend solves the arm
  const ik: Record<string, unknown> = {};
  for (const hand of ["right", "left"] as const) {
    // one chain per arm: several interactions using it are merged frame by frame (strongest wins)
    const rs = (extras.reaches ?? []).filter((x) => x.hand === hand);
    if (!rs.length) continue;
    const weights = new Array<number>(N).fill(0);
    const own: (ReachDrive | null)[] = new Array(N).fill(null);
    for (const x of rs)
      for (let f = 0; f < N; f++)
        if ((x.weights[f] ?? 0) > weights[f]) {
          weights[f] = x.weights[f];
          own[f] = x;
        }
    if (!weights.some((w) => w > 0)) continue;
    const r = { ...rs[0], weights };
    const chain = hand;
    // targets only matter while the weight is > 0: elsewhere hold the last (or next) active target
    const held: { x: number; y: number; z: number }[] = new Array(N);
    let lastT: { x: number; y: number; z: number } | null = null;
    for (let f = 0; f < N; f++) if (own[f]) held[f] = lastT = own[f]!.targets[f];
    else if (lastT) held[f] = lastT;
    const firstActive = own.findIndex(Boolean);
    for (let f = 0; f < firstActive; f++) held[f] = own[firstActive]!.targets[firstActive];
    const tg = (f: number) => held[f];
    const ikStatics: Record<string, number> = {};
    for (const ax of ["x", "y", "z"] as const) emitNumeric(tracks, ikStatics, owner, owner, `ik.${chain}.target.${ax}`, Array.from({ length: N }, (_, f) => tg(f)[ax]), 0.002);
    emitNumeric(tracks, ikStatics, owner, owner, `ik.${chain}.weight`, r.weights.slice(0, N), 0.01);
    ik[chain] = {
      upper: r.upper,
      lower: r.lower,
      end: r.end,
      side: r.hand,
      grip: r3(r.grip ?? 0),
      target: { x: ikStatics[`ik.${chain}.target.x`], y: ikStatics[`ik.${chain}.target.y`], z: ikStatics[`ik.${chain}.target.z`] },
      weight: ikStatics[`ik.${chain}.weight`],
    };
  }
  if (Object.keys(ik).length) obj.ik = ik;

  const objects: Record<string, unknown>[] = [obj];
  for (const prop of inst.props ?? []) {
    const id = `${owner}.${prop.id}`;
    const o: Record<string, unknown> = {
      id,
      asset: prop.asset,
      attach: { object: owner, bone: def.sockets?.[prop.socket] ?? prop.socket, follow: prop.follow ?? "full" },
      position: { x: 0, y: 0, z: 0, ...prop.position },
      rotation: { x: 0, y: 0, z: 0, ...prop.rotation3 },
      ...(prop.scale ? { scale: { x: prop.scale, y: prop.scale, z: prop.scale } } : {}),
      meta: { character: owner, generated: true, prop: prop.id, socket: prop.socket },
    };
    const hide = extras.hideProps?.[prop.id];
    if (prop.visibleFrom !== undefined || prop.visibleUntil !== undefined || hide !== undefined) {
      const a = Math.round((prop.visibleFrom ?? 0) * plan.fps);
      const b = Math.min(prop.visibleUntil !== undefined ? Math.round(prop.visibleUntil * plan.fps) : Infinity, hide ?? Infinity);
      emitDiscrete(tracks, o, owner, id, "visible", Array.from({ length: N }, (_, f) => f >= a && f < b));
    }
    objects.push(o);
  }
  const audio: CompiledCharacter["audio"] = plan.speech.filter((x) => x.audio).map((x) => ({ asset: x.audio!.asset, startFrame: x.f0, ...(x.audio!.volume !== undefined ? { volume: x.audio!.volume } : {}) }));
  return { objects, tracks, audio };
}
