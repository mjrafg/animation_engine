/**
 * Action planning, shared by 2D and 3D characters: resolves each high-level action against the
 * prepared character, converts seconds to frames, computes the locomotion path and facing,
 * builds speech viseme spans and blink times, and detects conflicts. The result is a
 * renderer-independent Plan; compile2d/compile3d turn it into layers/objects and tracks.
 *
 * Channels and composition rules (documented in docs/CHARACTERS.md):
 *  - locomotion (walk/run/idle...): exclusive; overlapping locomotion actions are a conflict.
 *    Gaps are filled with the character's idle.
 *  - body parts (gesture/look): each gesture CLAIMS parts (2D: arm/hand/head parts; 3D: the whole
 *    body clip). Two gestures claiming the same part at the same time conflict. A gesture
 *    overrides locomotion only on its claimed parts (2D: walk + wave = legs walk, arm waves).
 *    3D: a gesture replaces the body clip, so gesture + walk/run is a conflict.
 *  - expression: exclusive (one facial expression at a time; neutral when none).
 *  - mouth (talk): exclusive. Talk + expression combine (expression-specific mouth shapes when
 *    the character has them).
 *  - eyes (blink): blinks never conflict; overlapping blinks merge. Auto-blink adds seeded blinks.
 *  - facing (turn): exclusive per instant; walk/run face their direction automatically, so a turn
 *    during a move is a conflict.
 */
import type { ValidationIssue } from "../scene/validate.js";
import type { ActionDef, CharacterAction, CharacterDefinition, CharacterInstance, SpeechTiming } from "./schema.js";
import { hashSeed, planSpeech, prng, speechDuration, type VisemeSpan } from "./speech.js";

export type Channel = "locomotion" | "gesture" | "expression" | "mouth" | "eyes" | "facing";

export const KIND_CHANNEL: Record<ActionDef["kind"], Channel> = {
  locomotion: "locomotion",
  idle: "locomotion",
  gesture: "gesture",
  look: "gesture",
  expression: "expression",
  speech: "mouth",
  blink: "eyes",
  turn: "facing",
};

/** Every action the character supports: its own definitions plus built-ins it qualifies for. */
export function characterActions(def: CharacterDefinition): Record<string, ActionDef> {
  const out: Record<string, ActionDef> = {};
  const has3dClip = (name: string) => def.kind === "3d" && Object.values(def.actions).some((a) => a.clip === name);
  if (def.kind === "2d" ? def.motions.idle : has3dClip("idle")) out.idle = { kind: "idle", ...(def.kind === "2d" ? { motion: "idle" } : { clip: "idle" }) };
  else out.idle = { kind: "idle" };
  out.turn = { kind: "turn" };
  if (def.mouth) out.talk = { kind: "speech" };
  if (def.eyes) out.blink = { kind: "blink" };
  if (Object.keys(def.expressions).length) out.expression = { kind: "expression" };
  for (const e of Object.keys(def.expressions)) out[e] = { kind: "expression", expression: e };
  out.neutral = { kind: "expression", expression: "neutral" };
  for (const [k, v] of Object.entries(def.actions)) out[k] = v;
  return out;
}

export type Facing2D = 1 | -1;

export interface LocoSegment {
  actionId: string;
  name: string;
  type: "move" | "idle";
  f0: number;
  f1: number;
  motion?: string;
  clip?: string;
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
}

export interface GestureSegment {
  actionId: string;
  name: string;
  f0: number;
  f1: number;
  motion?: string;
  clip?: string;
  claims: string[];
}

export interface ExpressionSegment {
  actionId: string;
  name: string;
  f0: number;
  f1: number;
  intensity: number;
}

export interface SpeechSegment {
  actionId: string;
  f0: number;
  f1: number;
  source: string;
  intensity: number;
  /** Frame spans of visemes (absolute frames). */
  visemes: { viseme: VisemeSpan["viseme"]; f0: number; f1: number }[];
  audio?: { asset: string; volume?: number };
}

export interface FacingEvent {
  f0: number;
  frames: number;
  /** 2D: +1/-1 (world direction right/left). 3D: yaw degrees. */
  value: number;
  actionId?: string;
}

export interface Plan {
  kind: "2d" | "3d";
  fps: number;
  frames: number;
  start: { x: number; y: number; z: number };
  initialFacing: number;
  locomotion: LocoSegment[];
  gestures: GestureSegment[];
  expressions: ExpressionSegment[];
  speech: SpeechSegment[];
  blinks: { f0: number; f1: number; actionId?: string }[];
  facing: FacingEvent[];
  blendFrames: number;
  /** Per action: resolved frames and derived values, for inspection. */
  resolved: Record<string, Record<string, unknown>>;
}

export interface PlanResult {
  ok: boolean;
  plan?: Plan;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const YAW: Record<string, number> = { right: 90, left: -90, camera: 0, forward: 0, away: 180 };

export function facingValue(def: CharacterDefinition, f: string): number | null {
  if (def.kind === "3d") return YAW[f] ?? null;
  if (f === "right") return 1;
  if (f === "left") return -1;
  return null;
}

export interface PlanContext {
  fps: number;
  frames: number;
  /** Resolve a saved speech timing by id. */
  speech?: (id: string) => SpeechTiming | undefined;
}

export function planCharacter(inst: CharacterInstance, def: CharacterDefinition, ctx: PlanContext, instPath: (string | number)[] = []): PlanResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, p: (string | number)[], message: string, details?: Record<string, unknown>) =>
    errors.push({ severity: "error", code, path: [...instPath, ...p], message, ...(details ? { details } : {}) });
  const warn = (code: string, p: (string | number)[], message: string) => warnings.push({ severity: "warning", code, path: [...instPath, ...p], message });

  const { fps, frames } = ctx;
  const toF = (s: number) => Math.round(s * fps);
  const scale = inst.scale ?? 1;
  const blendFrames = Math.max(1, Math.round(def.defaults.blend * fps));
  const turnFrames = Math.max(1, Math.round(def.defaults.turnTime * fps));
  const supported = characterActions(def);

  const start = def.kind === "3d" ? { ...(inst.position ?? { x: 0, y: 0, z: 0 }) } : { x: inst.x ?? 0, y: inst.y ?? 0, z: 0 };
  const facing0Name = inst.facing ?? def.defaults.facing ?? (def.kind === "2d" ? def.rig.facing : "camera");
  const facing0 = facingValue(def, facing0Name);
  if (facing0 === null) err("INVALID_ACTION", ["facing"], `A ${def.kind} character cannot face "${facing0Name}"`, { supported: def.kind === "2d" ? ["left", "right"] : Object.keys(YAW) });

  const plan: Plan = {
    kind: def.kind,
    fps,
    frames,
    start,
    initialFacing: facing0 ?? 1,
    locomotion: [],
    gestures: [],
    expressions: [],
    speech: [],
    blinks: [],
    facing: [],
    blendFrames,
    resolved: {},
  };

  // --- 1. resolve every action ---------------------------------------------------------------
  interface Item {
    a: CharacterAction;
    i: number;
    id: string;
    def: ActionDef;
    f0: number;
    f1: number;
    durationSec: number;
  }
  const items: Item[] = [];
  const actions = inst.actions ?? [];
  const seen = new Set<string>();
  actions.forEach((a, i) => {
    const p = ["actions", i];
    const id = a.id ?? `a${i + 1}`;
    if (seen.has(id)) err("INVALID_ACTION", [...p, "id"], `Duplicate action id "${id}"`);
    seen.add(id);
    const ad = supported[a.action];
    if (!ad) {
      err("ACTION_NOT_SUPPORTED", [...p, "action"], `Character "${def.id}" has no action "${a.action}"`, { supported: Object.keys(supported).sort() });
      return;
    }
    if (a.duration !== undefined && a.end !== undefined) err("INVALID_ACTION", [...p], "Give duration or end, not both");
    let dur = a.duration ?? (a.end !== undefined ? a.end - a.start : undefined);
    if (dur !== undefined && dur <= 0) {
      err("INVALID_ACTION", [...p, "end"], "end must be after start");
      return;
    }
    // derived durations
    if (dur === undefined) {
      if (ad.kind === "speech") {
        const t = typeof a.speech === "string" ? ctx.speech?.(a.speech) : a.speech;
        dur = speechDuration(t);
      } else if (ad.kind === "blink") dur = a.count && a.count > 1 ? a.count * 0.6 : def.defaults.blinkDuration;
      else if (ad.kind === "turn") dur = def.defaults.turnTime;
      else if (ad.kind === "locomotion" && (a.to || a.distance)) dur = undefined; // computed from speed below
      if (dur === undefined && ad.kind !== "locomotion") {
        err("INVALID_ACTION", [...p, "duration"], `"${a.action}" needs a duration (or end)`);
        return;
      }
    }
    const f0 = toF(a.start);
    if (f0 >= frames) {
      err("ACTION_OUT_OF_RANGE", [...p, "start"], `"${a.action}" starts at ${a.start}s, after the scene end (${(frames / fps).toFixed(2)}s)`, { sceneSeconds: frames / fps });
      return;
    }
    items.push({ a, i, id, def: ad, f0, f1: dur !== undefined ? Math.max(f0 + 1, toF(a.start + dur)) : -1, durationSec: dur ?? -1 });
  });

  // --- 2. locomotion: path, derived durations, facing ------------------------------------------
  const loco = items.filter((x) => x.def.kind === "locomotion" || x.def.kind === "idle").sort((x, y) => x.f0 - y.f0 || x.i - y.i);
  let pos = { ...start };
  for (const it of loco) {
    const a = it.a;
    const p = ["actions", it.i];
    if (it.def.kind === "idle") {
      if (a.to || a.direction || a.distance) err("INVALID_ACTION", p, "idle takes no direction/to/distance");
      plan.locomotion.push({ actionId: it.id, name: a.action, type: "idle", f0: it.f0, f1: it.f1, motion: it.def.motion, clip: it.def.clip, from: { ...pos }, to: { ...pos } });
      continue;
    }
    const speed = a.speed ?? (it.def.speed ?? (def.kind === "2d" ? 160 : 1.2)) * scale;
    let target: { x: number; y: number; z: number };
    if (a.to) {
      target = def.kind === "2d" ? { x: a.to.x, y: a.to.y ?? pos.y, z: 0 } : { x: a.to.x, y: pos.y, z: a.to.z ?? pos.z };
    } else {
      const dir = a.direction;
      const vec2d: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0] };
      const vec3d: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], camera: [0, 1], away: [0, -1] };
      const v = dir ? (def.kind === "2d" ? vec2d : vec3d)[dir] : undefined;
      if (!v) {
        err("INVALID_ACTION", [...p, "direction"], `"${a.action}" needs direction ${def.kind === "2d" ? "left|right" : "left|right|camera|away"} or to`, {
          supported: def.kind === "2d" ? ["left", "right"] : ["left", "right", "camera", "away"],
        });
        continue;
      }
      const dist = a.distance ?? (it.durationSec > 0 ? speed * it.durationSec : undefined);
      if (dist === undefined) {
        err("INVALID_ACTION", [...p, "duration"], `"${a.action}" needs duration, distance or to`);
        continue;
      }
      target = def.kind === "2d" ? { x: pos.x + v[0] * dist, y: pos.y, z: 0 } : { x: pos.x + v[0] * dist, y: pos.y, z: pos.z + v[1] * dist };
    }
    const dist = Math.hypot(target.x - pos.x, target.y - pos.y, target.z - pos.z);
    if (it.f1 < 0) it.f1 = Math.max(it.f0 + 1, toF(a.start + dist / speed));
    // facing follows the direction of travel
    if (def.kind === "2d") {
      if (Math.abs(target.x - pos.x) > 1e-6) plan.facing.push({ f0: it.f0, frames: turnFrames, value: target.x > pos.x ? 1 : -1, actionId: it.id });
    } else if (Math.hypot(target.x - pos.x, target.z - pos.z) > 1e-6) {
      plan.facing.push({ f0: it.f0, frames: turnFrames, value: (Math.atan2(target.x - pos.x, target.z - pos.z) * 180) / Math.PI, actionId: it.id });
    }
    plan.locomotion.push({ actionId: it.id, name: a.action, type: "move", f0: it.f0, f1: it.f1, motion: it.def.motion, clip: it.def.clip, from: { ...pos }, to: target });
    plan.resolved[it.id] = { from: { ...pos }, to: target, speed: +(dist / ((it.f1 - it.f0) / fps)).toFixed(3) };
    pos = target;
  }

  // --- 3. the other channels ----------------------------------------------------------------------
  const autoSeed = (extra: number | undefined) => (hashSeed(inst.id) ^ (extra ?? 0)) >>> 0;
  for (const it of items) {
    const a = it.a;
    const p = ["actions", it.i];
    switch (it.def.kind) {
      case "gesture":
      case "look": {
        let motion = it.def.motion;
        if (it.def.kind === "look") {
          const d = a.direction ?? "forward";
          motion = it.def.motions?.[d];
          if (!motion && d !== "forward") {
            err("INVALID_ACTION", [...p, "direction"], `"${a.action}" supports directions: ${Object.keys(it.def.motions ?? {}).join(", ") || "none"}`);
            break;
          }
          if (!motion) break; // look forward = no override
        }
        let claims: string[] = ["body"];
        if (def.kind === "2d") {
          const m = motion ? def.motions[motion] : undefined;
          if (!m) {
            err("ACTION_NOT_SUPPORTED", [...p, "action"], `Motion "${motion}" of action "${a.action}" is missing from the character`);
            break;
          }
          claims = it.def.claims ?? [...new Set([...Object.keys(m.tracks).map((k) => k.slice(0, k.lastIndexOf("."))), ...Object.keys(m.assets ?? {})])];
        }
        plan.gestures.push({ actionId: it.id, name: a.action, f0: it.f0, f1: it.f1, motion, clip: it.def.clip, claims });
        break;
      }
      case "expression": {
        const name = it.def.expression ?? a.expression;
        if (!name) {
          err("INVALID_ACTION", [...p, "expression"], `"expression" needs an expression name`, { supported: Object.keys(def.expressions) });
          break;
        }
        if (name !== "neutral" && !def.expressions[name]) {
          err("ACTION_NOT_SUPPORTED", [...p, "expression"], `Character "${def.id}" has no expression "${name}"`, { supported: ["neutral", ...Object.keys(def.expressions)] });
          break;
        }
        plan.expressions.push({ actionId: it.id, name, f0: it.f0, f1: it.f1, intensity: a.intensity ?? 1 });
        break;
      }
      case "speech": {
        let timing: SpeechTiming | undefined;
        if (typeof a.speech === "string") {
          timing = ctx.speech?.(a.speech);
          if (!timing) {
            err("SPEECH_NOT_FOUND", [...p, "speech"], `No speech timing "${a.speech}"`);
            break;
          }
        } else timing = a.speech;
        const durSec = (it.f1 - it.f0) / fps;
        const sp = planSpeech(timing, durSec, autoSeed(a.seed), 1.5 / fps);
        const visemes = sp.spans
          .map((s) => ({ viseme: s.viseme, f0: it.f0 + toF(s.start), f1: Math.min(it.f1, it.f0 + toF(s.end)) }))
          .filter((s) => s.f1 > s.f0);
        plan.speech.push({ actionId: it.id, f0: it.f0, f1: it.f1, source: sp.source, intensity: a.intensity ?? 1, visemes, ...(timing?.audio ? { audio: { asset: timing.audio, volume: timing.volume } } : {}) });
        plan.resolved[it.id] = { speechSource: sp.source, visemes: visemes.length, ...(timing?.audio ? { audio: timing.audio } : {}) };
        if (sp.source === "generic") plan.resolved[it.id].note = "no timing given: generic talking (deterministic)";
        break;
      }
      case "blink": {
        const bf = Math.max(2, Math.round(def.defaults.blinkDuration * fps));
        const span = it.f1 - it.f0;
        const n = a.interval ? Math.max(1, Math.floor(span / (a.interval * fps))) : a.count ?? 1;
        const rnd = prng(autoSeed(a.seed));
        for (let k = 0; k < n; k++) {
          const base = a.interval ? it.f0 + Math.round(k * a.interval * fps + rnd() * Math.min(0.3 * a.interval * fps, 8)) : it.f0 + Math.round((k * span) / n);
          plan.blinks.push({ f0: base, f1: base + bf, actionId: it.id });
        }
        break;
      }
      case "turn": {
        const d = a.direction;
        const v = d ? facingValue(def, d) : null;
        if (v === null) {
          err("INVALID_ACTION", [...p, "direction"], `turn needs direction ${def.kind === "2d" ? "left|right" : "left|right|camera|away"}`, {
            supported: def.kind === "2d" ? ["left", "right"] : ["left", "right", "camera", "away"],
          });
          break;
        }
        plan.facing.push({ f0: it.f0, frames: it.f1 - it.f0, value: v, actionId: it.id });
        break;
      }
      default:
        break;
    }
    plan.resolved[it.id] = { ...plan.resolved[it.id], action: a.action, kind: it.def.kind, channel: KIND_CHANNEL[it.def.kind], startFrame: it.f0, endFrame: it.f1, start: +(it.f0 / fps).toFixed(3), end: +(it.f1 / fps).toFixed(3) };
    if (it.f1 > frames) warn("ACTION_PAST_END", p, `"${a.action}" runs past the scene end (${(frames / fps).toFixed(2)}s); it is cut there`);
  }

  // auto blink (deterministic, seeded by instance id)
  const ab = inst.autoBlink ?? true;
  if (def.eyes && ab !== false) {
    const interval = (typeof ab === "object" ? ab.interval : undefined) ?? def.defaults.autoBlinkInterval;
    const rnd = prng(autoSeed(typeof ab === "object" ? ab.seed : undefined) ^ 0x9e3779b9);
    const bf = Math.max(2, Math.round(def.defaults.blinkDuration * fps));
    let f = Math.round((0.6 + rnd() * interval) * fps);
    while (f < frames) {
      plan.blinks.push({ f0: f, f1: f + bf });
      f += Math.round(interval * (0.6 + rnd() * 0.8) * fps);
    }
  }

  // --- 4. conflicts ------------------------------------------------------------------------------
  const overlap = (x: { f0: number; f1: number }, y: { f0: number; f1: number }) => x.f0 < y.f1 && y.f0 < x.f1;
  const conflict = (x: { actionId: string }, y: { actionId: string }, channel: string, extra: Record<string, unknown> = {}) =>
    err("ACTION_CONFLICT", ["actions"], `Actions "${x.actionId}" and "${y.actionId}" overlap on the ${channel} channel`, { actions: [x.actionId, y.actionId], channel, ...extra });
  const pairs = <T extends { f0: number; f1: number; actionId: string }>(list: T[], channel: string, same: (a: T, b: T) => string[] | boolean = () => true) => {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (!overlap(list[i], list[j])) continue;
        const s = same(list[i], list[j]);
        if (s === true || (Array.isArray(s) && s.length)) conflict(list[i], list[j], channel, Array.isArray(s) ? { parts: s } : {});
      }
  };
  pairs(plan.locomotion, "locomotion");
  pairs(plan.gestures, "body-part", (a, b) => a.claims.filter((c) => b.claims.includes(c)));
  pairs(plan.expressions, "expression");
  pairs(plan.speech, "mouth");
  const turns = plan.facing.filter((f) => items.find((x) => x.id === f.actionId)?.def.kind === "turn").map((f) => ({ ...f, f1: f.f0 + f.frames, actionId: f.actionId! }));
  pairs(turns, "facing");
  for (const t of turns) for (const m of plan.locomotion.filter((l) => l.type === "move")) if (overlap(t, m)) conflict(t, m, "facing", { rule: "walk/run face their direction; turn before or after the move" });
  if (def.kind === "3d") {
    for (const g of plan.gestures)
      for (const m of plan.locomotion.filter((l) => l.type === "move"))
        if (overlap(g, m)) conflict(g, m, "body", { rule: "3D gestures play a full-body clip; they cannot overlap walk/run (schedule them before or after)" });
  }

  plan.facing.sort((x, y) => x.f0 - y.f0);
  plan.locomotion.sort((x, y) => x.f0 - y.f0);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, plan, errors, warnings };
}

// ---- per-frame helpers used by the compilers --------------------------------------------------

export const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Blend weight of a segment at frame f (ramps in/out over b frames inside the segment). */
export function weightAt(seg: { f0: number; f1: number }, f: number, b: number): number {
  if (f < seg.f0 || f >= seg.f1) return 0;
  const len = seg.f1 - seg.f0;
  const bb = Math.min(b, len / 2);
  if (bb <= 0) return 1;
  return Math.min(smooth((f - seg.f0 + 1) / bb), smooth((seg.f1 - f) / bb));
}

/** Root position at frame f. */
export function positionAt(plan: Plan, f: number) {
  let pos = plan.start;
  for (const s of plan.locomotion) {
    if (f < s.f0) break;
    if (f >= s.f1) {
      pos = s.to;
      continue;
    }
    const t = (f - s.f0) / (s.f1 - s.f0);
    return { x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t, z: s.from.z + (s.to.z - s.from.z) * t };
  }
  return { ...pos };
}

/** Facing at frame f: 2D a value in [-1, 1] (flips through 0), 3D yaw degrees (shortest turn). */
export function facingAt(plan: Plan, f: number): number {
  let v = plan.initialFacing;
  for (const e of plan.facing) {
    if (f < e.f0) break;
    const t = e.frames <= 0 ? 1 : smooth((f - e.f0) / e.frames);
    if (plan.kind === "2d") v = v + (e.value - v) * t;
    else {
      let d = ((e.value - v + 540) % 360) - 180;
      if (Math.abs(d) < 1e-9) d = 0;
      v = v + d * t;
    }
  }
  return v;
}
