/**
 * Multi-character interaction runtime.
 *
 * An interaction instance (scene `interactions[]`) names a reusable definition, its actors (one
 * character instance per role), a start time and a duration. `planScene` turns all of them into
 * ordinary character plans:
 *
 *  1. Alignment (in start order): from where the actors are at the start, the definition's
 *     alignment computes where each must stand (face to face, at a distance derived from their
 *     own arm reach and height, so differently sized characters adapt). The runtime injects plan
 *     actions with `source` = the interaction id: an approach walk (approach phase), a turn to
 *     face the partner, holds (idle) that reserve the locomotion channel for the interaction, and
 *     reaction moves (e.g. pushed back). They obey the normal channel/conflict rules, so an
 *     overlapping walk or turn of the character is reported as ACTION_CONFLICT naming both.
 *  2. Reaches: every effector (role + hand + target) becomes a per-frame world target and weight
 *     (ramping in over its `from` phase, out from its `until` phase). The compilers solve a
 *     two-bone IK so the hand's grip point meets the target (2D in the compiler, 3D in the
 *     backend via `ik` tracks). Reaches claim the arm: an overlapping gesture using that arm
 *     conflicts.
 *  3. Object transfer: the giver's prop is shown until the transfer frame; a copy attached to the
 *     receiver's hand is shown from it, placed so the object does not jump (2D: exact from both
 *     hands' matrices; 3D: from the solved contact geometry). Ownership chains across
 *     interactions (A gives to B, later B gives to C).
 *
 * Everything is deterministic and derived from stored data (instances, interactions, definitions),
 * so save/reload/re-render reproduces it exactly.
 */
import { is3D, type SceneDoc } from "../api/operations.js";
import { apply, compose, identity, invert, multiply, rotateDeg, scale as scaleM, translate, type Mat2D } from "../math/matrix.js";
import type { ValidationIssue } from "../scene/validate.js";
import type { ModelInfo } from "../scene3d/gltf.js";
import { partPointOffset, pointInPart, type CompiledCharacter, type ReachDrive } from "./compile.js";
import { interactionSha, type HeightSpec, type InteractionDefinition, type TargetSpec } from "./interaction-defs.js";
import { characterActions, facingAt, planCharacter, positionAt, smooth, type Plan, type PlanAction } from "./plan.js";
import type { Character2D, Character3D, CharacterDefinition, CharacterInstance, InteractionInstance, SpeechTiming } from "./schema.js";

export type Hand = "right" | "left";
export type V3 = { x: number; y: number; z: number };

/** Lookups the interaction runtime needs on top of the character runtime's. */
export interface InteractionLookups {
  definition(id: string): { def: CharacterDefinition; sha: string } | undefined;
  speech?(id: string): SpeechTiming | undefined;
  interaction?(id: string): { def: InteractionDefinition; sha: string; builtin: boolean } | undefined;
  /** 3D: model facts (joints, rest positions, bounds) of a model asset. */
  model?(assetId: string): ModelInfo | undefined;
}

// ---- actor dimensions ---------------------------------------------------------------------------

export interface ArmDims {
  hand: Hand;
  socket: string;
  /** 2D part ids / 3D joint names of the chain. */
  upper: string;
  lower: string;
  end: string;
  /** 2D: attachment point of the socket on the end part. */
  point?: string;
  /** Shoulder relative to the feet in the actor's own frame: forward (facing), up, lateral (+ = its left; 3D). */
  shoulder: { forward: number; up: number; lateral: number };
  upperLength: number;
  lowerLength: number;
  /** 3D: wrist-to-palm distance used as the IK grip point. */
  grip: number;
  /** Shoulder-to-grip-point length with the arm straight. */
  reach: number;
}

export interface ActorDims {
  kind: "2d" | "3d";
  /** World units: 2D canvas px, 3D metres (instance scale applied). */
  height: number;
  arms: Partial<Record<Hand, ArmDims>>;
  /** Why an arm is unavailable (missing socket, too short a chain, no rest pose). */
  armIssues: Partial<Record<Hand, string>>;
}

const HAND_SOCKET: Record<Hand, string> = { right: "rightHand", left: "leftHand" };
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r3 = (v: number) => Math.round(v * 1e3) / 1e3;

function restFK2D(def: Character2D) {
  const byId = new Map(def.rig.parts.map((p) => [p.id, p]));
  const local = (id: string): Mat2D => {
    const p = byId.get(id)!;
    const o = partPointOffset(def, p);
    return compose(translate(o.x + p.x, o.y + p.y), rotateDeg(p.rotation), scaleM(p.scaleX, p.scaleY));
  };
  return (id: string): Mat2D => {
    const chain: string[] = [];
    for (let cur: string | null | undefined = id; cur; cur = byId.get(cur)?.parent ?? null) chain.unshift(cur);
    return chain.reduce((m, c) => multiply(m, local(c)), identity());
  };
}

export function actorDims(def: CharacterDefinition, inst: Pick<CharacterInstance, "scale">, model?: ModelInfo): ActorDims {
  const arms: ActorDims["arms"] = {};
  const armIssues: ActorDims["armIssues"] = {};
  if (def.kind === "2d") {
    const s = inst.scale ?? 1;
    const fk = restFK2D(def);
    const byId = new Map(def.rig.parts.map((p) => [p.id, p]));
    const rigSign = def.rig.facing === "right" ? 1 : -1;
    let minY = 0;
    for (const p of def.rig.parts) {
      if (!p.width || !p.height) continue;
      const m = fk(p.id);
      for (const [cx, cy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ])
        minY = Math.min(minY, apply(m, { x: (cx - p.anchorX) * p.width, y: (cy - p.anchorY) * p.height }).y);
    }
    for (const hand of ["right", "left"] as Hand[]) {
      const socket = HAND_SOCKET[hand];
      const sk = def.sockets[socket];
      const end = sk ? byId.get(sk.part) : undefined;
      const lower = end?.parent ? byId.get(end.parent) : undefined;
      const upper = lower?.parent ? byId.get(lower.parent) : undefined;
      if (!sk || !end) {
        armIssues[hand] = `no socket "${socket}"`;
        continue;
      }
      if (!lower || !upper) {
        armIssues[hand] = `socket "${socket}" (part ${end.id}) needs two parent parts (forearm, upper arm) for reaching`;
        continue;
      }
      const sh = apply(fk(upper.id), { x: 0, y: 0 });
      const el = apply(fk(lower.id), { x: 0, y: 0 });
      const gp = apply(fk(end.id), pointInPart(end, sk.point));
      const L1 = Math.hypot(el.x - sh.x, el.y - sh.y) * s;
      const L2 = Math.hypot(gp.x - el.x, gp.y - el.y) * s;
      arms[hand] = {
        hand,
        socket,
        upper: upper.id,
        lower: lower.id,
        end: end.id,
        ...(sk.point ? { point: sk.point } : {}),
        shoulder: { forward: r4(sh.x * rigSign * s), up: r4(-sh.y * s), lateral: 0 },
        upperLength: r4(L1),
        lowerLength: r4(L2),
        grip: 0,
        reach: r4(L1 + L2),
      };
    }
    return { kind: "2d", height: r4(-minY * s), arms, armIssues };
  }
  const s = (inst.scale ?? 1) * def.scale;
  const height = model?.bounds ? model.bounds.max[1] * s : 0;
  for (const hand of ["right", "left"] as Hand[]) {
    const socket = HAND_SOCKET[hand];
    if (!model?.rigged) {
      armIssues[hand] = "model is not rigged";
      continue;
    }
    const joint = def.sockets?.[socket] ?? model.sockets[socket];
    const parent = (j: string | undefined) => (j ? model.joints.find((x) => x.name === j)?.parent ?? undefined : undefined);
    const lower = parent(joint);
    const upper = parent(lower);
    if (!joint) {
      armIssues[hand] = `no socket "${socket}"`;
      continue;
    }
    if (!lower || !upper) {
      armIssues[hand] = `socket "${socket}" (joint ${joint}) needs two parent joints (forearm, upper arm)`;
      continue;
    }
    const rest = model.jointRest;
    if (!rest?.[joint] || !rest[lower] || !rest[upper]) {
      armIssues[hand] = "model has no rest pose data (re-import the model)";
      continue;
    }
    const [sx, sy, sz] = rest[upper];
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * s;
    const L1 = d(rest[upper], rest[lower]);
    const L2 = d(rest[lower], rest[joint]);
    const grip = 0.3 * L2;
    arms[hand] = {
      hand,
      socket,
      upper,
      lower,
      end: joint,
      shoulder: { forward: r4(sz * s), up: r4(sy * s), lateral: r4(sx * s) },
      upperLength: r4(L1),
      lowerLength: r4(L2),
      grip: r4(grip),
      reach: r4(L1 + L2 + grip),
    };
  }
  return { kind: "3d", height: r4(height), arms, armIssues };
}

// ---- geometry -----------------------------------------------------------------------------------

/** Actor-local point (forward along its facing, up, lateral toward its left) -> world. */
export function toWorld(kind: "2d" | "3d", pos: V3, facing: number, local: { forward: number; up: number; lateral: number }): V3 {
  if (kind === "2d") {
    const sg = facing < 0 ? -1 : 1;
    return { x: pos.x + sg * local.forward, y: pos.y - local.up, z: 0 };
  }
  const p = (facing * Math.PI) / 180;
  return {
    x: pos.x + local.forward * Math.sin(p) + local.lateral * Math.cos(p),
    y: pos.y + local.up,
    z: pos.z + local.forward * Math.cos(p) - local.lateral * Math.sin(p),
  };
}

const dist3 = (a: V3, b: V3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const flat = (kind: "2d" | "3d", a: V3, b: V3) => (kind === "2d" ? Math.abs(a.x - b.x) : Math.hypot(a.x - b.x, a.z - b.z));

function armOf(d: ActorDims, hand: Hand): ArmDims | undefined {
  return d.arms[hand] ?? d.arms.right ?? d.arms.left;
}

function evalHeight(spec: HeightSpec | undefined, dims: ActorDims[]): number {
  const sh = dims.reduce((s, d) => s + (armOf(d, "right")?.shoulder.up ?? d.height * 0.75), 0) / dims.length;
  const reach = Math.min(...dims.map((d) => armOf(d, "right")?.reach ?? d.height * 0.3));
  const h = dims.reduce((s, d) => s + d.height, 0) / dims.length;
  if (!spec || (spec.shoulder === undefined && spec.reach === undefined && spec.height === undefined)) return sh;
  return (spec.shoulder ?? 0) * sh + (spec.reach ?? 0) * reach + (spec.height ?? 0) * h;
}

/** How far forward of its feet an actor's grip reaches at world height h (above its feet). */
function forwardReach(arm: ArmDims, h: number, rho: number): { fwd: number; ok: boolean } {
  const r = rho * arm.reach;
  const q = r * r - (h - arm.shoulder.up) ** 2 - arm.shoulder.lateral ** 2;
  return q >= 0 ? { fwd: arm.shoulder.forward + Math.sqrt(q), ok: true } : { fwd: arm.shoulder.forward, ok: false };
}

// ---- plans --------------------------------------------------------------------------------------

export interface PhasePlan {
  name: string;
  f0: number;
  f1: number;
}

export interface ReachPlan extends ReachDrive {
  ix: string;
  actor: string;
  role: string;
  target: string;
  /** Frames: reaching starts, contact (full weight) starts/ends, reach ends. */
  f0: number;
  contactF0: number;
  contactF1: number;
  f1: number;
  claims: string[];
  /** Largest predicted distance the grip stays short of the target while in contact (world units). */
  predictedMiss: number;
}

export interface Holding {
  actor: string;
  object: string;
  /** Layer/object id showing the object while this actor holds it. */
  layer: string;
  hand: Hand | null;
  own: boolean;
  from: number;
  until: number;
  /** Interaction that handed it over (copies). */
  ix?: string;
  /** The holding it was received from (copies). */
  prev?: Holding;
}

export interface TransferPlan {
  ix: string;
  object: string;
  from: string;
  to: string;
  frame: number;
  fromLayer: string;
  toLayer: string;
  giverHand: Hand;
  receiverHand: Hand;
  given: Holding;
  received: Holding;
}

export interface InteractionPlan {
  id: string;
  index: number;
  interaction: string;
  sha: string;
  def: InteractionDefinition;
  actors: string[];
  roles: Record<string, string>;
  params: NonNullable<InteractionInstance["params"]>;
  f0: number;
  f1: number;
  phases: PhasePlan[];
  distance?: number;
  anchor?: string;
  along: number;
  alignment: Record<string, { from: V3; to: V3; facing: number; walks: boolean }>;
  injected: Record<string, string[]>;
}

export interface ScenePlan {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  plans: Record<string, Plan>;
  defs: Record<string, CharacterDefinition>;
  dims: Record<string, ActorDims>;
  interactions: InteractionPlan[];
  reaches: Record<string, ReachPlan[]>;
  transfers: TransferPlan[];
  holdings: Holding[];
  hideProps: Record<string, Record<string, number>>;
}

export function interactionList(doc: SceneDoc): InteractionInstance[] {
  return (doc.interactions ?? []) as InteractionInstance[];
}

export const interactionIdOf = (ix: InteractionInstance, k: number) => ix.id ?? `ix${k + 1}`;

/** Hand used by an effector (null = resolved from the held object later). */
function effectorHand(e: InteractionDefinition["effectors"][number], params: InteractionInstance["params"]): Hand | null {
  if (e.hand === "right" || e.hand === "left") return e.hand;
  if (e.hand === "param") return params?.hand ?? "right";
  return null;
}

/** Plans every character in the scene together with its interactions. */
export function planScene(doc: SceneDoc, ctx: InteractionLookups): ScenePlan {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, path: (string | number)[], message: string, details?: Record<string, unknown>) =>
    errors.push({ severity: "error", code, path, message, ...(details ? { details } : {}) });
  const warn = (code: string, path: (string | number)[], message: string, details?: Record<string, unknown>) =>
    warnings.push({ severity: "warning", code, path, message, ...(details ? { details } : {}) });
  const out: ScenePlan = { ok: false, errors, warnings, plans: {}, defs: {}, dims: {}, interactions: [], reaches: {}, transfers: [], holdings: [], hideProps: {} };

  const kind: "2d" | "3d" = is3D(doc) ? "3d" : "2d";
  const fps: number = doc.canvas.fps;
  const frames: number = doc.duration;
  const insts = (doc.characters ?? []) as CharacterInstance[];
  const index = new Map(insts.map((c, i) => [c.id, i]));
  for (const [i, inst] of insts.entries()) {
    const e = ctx.definition(inst.character);
    if (!e) {
      err("CHARACTER_NOT_FOUND", ["characters", i, "character"], `No prepared character "${inst.character}" in this workspace (character_import it first)`);
      continue;
    }
    if (e.def.kind !== kind) {
      err("INVALID_ACTION", ["characters", i, "character"], `"${inst.character}" is a ${e.def.kind.toUpperCase()} character; this is a ${kind.toUpperCase()} scene`);
      continue;
    }
    out.defs[inst.id] = e.def;
  }
  if (errors.length) return out;
  const dimsOf = (id: string) => {
    if (!out.dims[id]) {
      const def = out.defs[id];
      out.dims[id] = actorDims(def, insts[index.get(id)!], def.kind === "3d" ? ctx.model?.(def.model) : undefined);
    }
    return out.dims[id];
  };
  const extras: Record<string, PlanAction[]> = Object.fromEntries(insts.map((c) => [c.id, []]));
  const pctx = { fps, frames, speech: ctx.speech?.bind(ctx) };
  const planOf = (id: string) => planCharacter(insts[index.get(id)!], out.defs[id], pctx, ["characters", index.get(id)!], extras[id]);

  // --- 1. static checks
  const list = interactionList(doc);
  const seen = new Set<string>();
  const ixs: InteractionPlan[] = [];
  list.forEach((ix, k) => {
    const p = ["interactions", k];
    const id = interactionIdOf(ix, k);
    if (seen.has(id)) err("INTERACTION_INVALID", [...p, "id"], `Duplicate interaction id "${id}"`);
    seen.add(id);
    const entry = ctx.interaction?.(ix.interaction);
    if (!entry) {
      err("INTERACTION_NOT_FOUND", [...p, "interaction"], `No interaction definition "${ix.interaction}" (interaction_list shows the available ones)`);
      return;
    }
    const def = entry.def;
    if (ix.actors.length !== def.roles.length) {
      err("INTERACTION_INVALID", [...p, "actors"], `"${def.id}" needs ${def.roles.length} actor(s) (${def.roles.map((r) => r.name).join(", ")}), got ${ix.actors.length}`, { roles: def.roles.map((r) => r.name) });
      return;
    }
    if (new Set(ix.actors).size !== ix.actors.length) {
      err("INTERACTION_INVALID", [...p, "actors"], "An actor cannot take two roles in the same interaction");
      return;
    }
    let bad = false;
    ix.actors.forEach((a, i) => {
      if (!index.has(a)) {
        err("CHARACTER_NOT_FOUND", [...p, "actors", i], `No character instance "${a}" in this scene`, { instances: insts.map((c) => c.id) });
        bad = true;
      }
    });
    if (bad) return;
    const dur = ix.duration ?? def.duration.default;
    if (dur < def.duration.min) err("INTERACTION_INVALID", [...p, "duration"], `"${def.id}" needs at least ${def.duration.min}s (got ${dur}s)`, { min: def.duration.min });
    for (const [name, spec] of Object.entries(def.params)) {
      if (spec.required && (ix.params as Record<string, unknown> | undefined)?.[name] === undefined) err("INTERACTION_INVALID", [...p, "params", name], `"${def.id}" needs params.${name}${spec.description ? ` (${spec.description})` : ""}`);
    }
    const roles = Object.fromEntries(def.roles.map((r, i) => [r.name, ix.actors[i]]));
    // compatibility: arms for the effectors, required actions/sockets
    for (const [ri, role] of def.roles.entries()) {
      const actor = ix.actors[ri];
      const cdef = out.defs[actor];
      const supported = characterActions(cdef);
      const missingActions = role.requires.actions.filter((a) => a !== "walk" && !supported[a]);
      const sockets = cdef.kind === "2d" ? Object.keys(cdef.sockets) : Object.keys({ ...(ctx.model?.(cdef.model)?.sockets ?? {}), ...(cdef.sockets ?? {}) });
      const missingSockets = role.requires.sockets.filter((s) => !sockets.includes(s));
      const d = dimsOf(actor);
      const missingArms: string[] = [];
      for (const e of def.effectors.filter((x) => x.role === role.name)) {
        const h = effectorHand(e, ix.params);
        if (h && !d.arms[h]) missingArms.push(`${h} arm: ${d.armIssues[h] ?? "unavailable"}`);
        if (!h && !d.arms.right && !d.arms.left) missingArms.push("no arm can reach");
      }
      if (missingActions.length || missingSockets.length || missingArms.length) {
        err("INTERACTION_INCOMPATIBLE", [...p, "actors", ri], `"${actor}" (${cdef.id}) cannot play role "${role.name}" of "${def.id}": ${[...missingActions.map((a) => `action ${a}`), ...missingSockets.map((s) => `socket ${s}`), ...missingArms].join("; ")}`, {
          role: role.name,
          actor,
          character: cdef.id,
          missing: { actions: missingActions, sockets: missingSockets, arms: missingArms },
        });
      }
    }
    const f0 = Math.round(ix.start * fps);
    const f1 = Math.max(f0 + 1, Math.round((ix.start + dur) * fps));
    let prev = f0;
    const phases = def.phases.map((ph) => {
      const end = f0 + Math.round(ph.end * (f1 - f0));
      const r = { name: ph.name, f0: prev, f1: Math.max(prev, end) };
      prev = r.f1;
      return r;
    });
    if (f0 >= frames) err("ACTION_OUT_OF_RANGE", [...p, "start"], `Interaction "${id}" starts at ${ix.start}s, after the scene end (${(frames / fps).toFixed(2)}s)`);
    else if (f1 > frames) warn("ACTION_PAST_END", [...p], `Interaction "${id}" runs past the scene end; it is cut there`);
    ixs.push({ id, index: k, interaction: def.id, sha: entry.sha, def, actors: ix.actors, roles, params: ix.params ?? {}, f0, f1, phases, along: 0.5, alignment: {}, injected: {} });
  });
  if (errors.length) return out;
  ixs.sort((a, b) => a.f0 - b.f0 || a.index - b.index);

  // --- 2. alignment and injected actions, in start order
  for (const ip of ixs) {
    const def = ip.def;
    const p = ["interactions", ip.index];
    const inject = (actor: string, a: PlanAction) => {
      extras[actor].push({ ...a, source: ip.id, path: p });
      (ip.injected[actor] ??= []).push(`${a.id}:${a.action}`);
    };
    const sec = (f: number) => r4(f / fps);
    const moveWindows: Record<string, [number, number][]> = {};
    const addMoves = (pos: Record<string, V3>, face: Record<string, number>) => {
      for (const m of def.moves) {
        const actor = ip.roles[m.role];
        const ph = ip.phases.find((x) => x.name === m.phase)!;
        if (ph.f1 <= ph.f0) continue;
        if (!characterActions(out.defs[actor]).walk) {
          err("INTERACTION_INCOMPATIBLE", [...p, "actors", ip.actors.indexOf(actor)], `"${actor}" has no walk action for the "${m.phase}" move of "${def.id}"`, { role: m.role, actor, missing: { actions: ["walk"] } });
          continue;
        }
        const d = dimsOf(actor);
        const to = toWorld(kind, pos[actor], face[actor], { forward: -m.back * d.height, up: 0, lateral: 0 });
        inject(actor, { id: `${ip.id}:${m.role}:back`, action: "walk", start: sec(ph.f0), duration: sec(ph.f1 - ph.f0), to: kind === "2d" ? { x: r3(to.x), y: r3(pos[actor].y) } : { x: r4(to.x), z: r4(to.z) }, keepFacing: true });
        (moveWindows[actor] ??= []).push([ph.f0, ph.f1]);
      }
    };
    const holds = (actor: string, from: number) => {
      const wins = (moveWindows[actor] ?? []).sort((a, b) => a[0] - b[0]);
      let cur = from;
      let n = 0;
      const seg = (a: number, b: number) => {
        if (b - a >= 1) inject(actor, { id: `${ip.id}:hold${n++ ? n : ""}`, action: "idle", start: sec(a), duration: sec(b - a) });
      };
      for (const [a, b] of wins) {
        seg(cur, a);
        cur = Math.max(cur, b);
      }
      seg(cur, ip.f1);
    };

    if (def.alignment.mode === "none") {
      const pos: Record<string, V3> = {};
      const face: Record<string, number> = {};
      for (const a of ip.actors) {
        const r = planOf(a);
        if (!r.ok) return { ...out, errors: [...errors, ...r.errors] };
        pos[a] = positionAt(r.plan!, ip.f0);
        face[a] = facingAt(r.plan!, ip.f0);
        ip.alignment[a] = { from: pos[a], to: pos[a], facing: face[a], walks: false };
      }
      addMoves(pos, face);
      for (const a of ip.actors) holds(a, ip.f0);
      continue;
    }

    const [A, B] = ip.actors;
    const rA = planOf(A);
    const rB = planOf(B);
    if (!rA.ok || !rB.ok) {
      errors.push(...rA.errors, ...rB.errors);
      return out;
    }
    const PA = positionAt(rA.plan!, ip.f0);
    const PB = positionAt(rB.plan!, ip.f0);
    const dA = dimsOf(A);
    const dB = dimsOf(B);
    const avgH = (dA.height + dB.height) / 2;

    // distance from the actors' reach toward the shared target height
    const between = Object.values(def.targets).find((t) => t.kind === "between") as Extract<TargetSpec, { kind: "between" }> | undefined;
    const hT = evalHeight(def.alignment.height ?? between?.height, [dA, dB]);
    const rolesWithBetween = [...new Set(def.effectors.filter((e) => def.targets[e.target]?.kind === "between").map((e) => e.role))];
    const reachRoles = def.alignment.distance.roles ?? rolesWithBetween;
    const hr: Record<string, number> = {};
    for (const role of reachRoles) {
      const actor = ip.roles[role];
      const e = def.effectors.find((x) => x.role === role);
      const arm = armOf(dimsOf(actor), (e && effectorHand(e, ip.params)) || "right");
      if (!arm) continue;
      const fr = forwardReach(arm, hT, def.alignment.distance.reach);
      if (!fr.ok) {
        warn("INTERACTION_OUT_OF_REACH", [...p, "actors", ip.actors.indexOf(actor)], `"${actor}" cannot reach the ${def.id} height (${r3(hT)} ${kind === "2d" ? "px" : "m"} above the feet) with its arm; its hand stops short`, {
          actor,
          targetHeight: r3(hT),
          shoulderHeight: arm.shoulder.up,
          reach: arm.reach,
        });
      }
      hr[role] = fr.fwd;
    }
    let D = Object.values(hr).reduce((s, v) => s + v, 0) + def.alignment.distance.height * avgH;
    D = Math.max(D, 0.05 * avgH);
    ip.distance = r4(D);
    const r0 = def.roles[0].name;
    const r1 = def.roles[1].name;
    ip.along = hr[r0] !== undefined && hr[r1] !== undefined && hr[r0] + hr[r1] > 0 ? hr[r0] / (hr[r0] + hr[r1]) : 0.5;

    // aligned positions
    const anchor = ip.params.anchor ?? def.alignment.anchor;
    ip.anchor = anchor;
    let dir: V3; // unit vector from B toward A (horizontal)
    const dx = PA.x - PB.x;
    const dz = kind === "3d" ? PA.z - PB.z : 0;
    const len = kind === "2d" ? Math.abs(dx) : Math.hypot(dx, dz);
    if (len > 1e-6) dir = kind === "2d" ? { x: Math.sign(dx), y: 0, z: 0 } : { x: dx / len, y: 0, z: dz / len };
    else {
      const fb = facingAt(rB.plan!, ip.f0);
      dir = kind === "2d" ? { x: fb < 0 ? -1 : 1, y: 0, z: 0 } : { x: Math.sin((fb * Math.PI) / 180), y: 0, z: Math.cos((fb * Math.PI) / 180) };
    }
    const at = (o: V3, k: number, keepY: number): V3 => ({ x: o.x + dir.x * k, y: kind === "2d" ? keepY : o.y, z: o.z + dir.z * k });
    let TA: V3;
    let TB: V3;
    if (anchor === "first") {
      TA = PA;
      TB = at(PA, -D, PB.y);
    } else if (anchor === "midpoint") {
      const M = { x: (PA.x + PB.x) / 2, y: 0, z: (PA.z + PB.z) / 2 };
      TA = at(M, D / 2, PA.y);
      TB = at(M, -D / 2, PB.y);
    } else {
      TA = at(PB, D, PA.y);
      TB = PB;
    }
    const faceToward = (from: V3, to: V3) => (kind === "2d" ? (to.x >= from.x ? 1 : -1) : (Math.atan2(to.x - from.x, to.z - from.z) * 180) / Math.PI);
    const want: Record<string, number> = { [A]: faceToward(TA, TB), [B]: faceToward(TB, TA) };
    const tol = 0.01 * avgH;
    const approach = ip.phases.find((x) => x.name === "approach");
    const holdFrom: Record<string, number> = {};
    for (const [actor, P, T, plan] of [
      [A, PA, TA, rA.plan!],
      [B, PB, TB, rB.plan!],
    ] as const) {
      const cdef = out.defs[actor];
      const moving = flat(kind, P, T) > tol;
      const cur = facingAt(plan, ip.f0);
      const facingOk = kind === "2d" ? Math.sign(cur) === Math.sign(want[actor]) && Math.abs(cur) > 0.99 : Math.abs(((want[actor] - cur + 540) % 360) - 180) < 2;
      // walking toward the partner turns the actor toward it; backing up keeps its facing
      const towardPartner = moving && (kind === "2d" ? Math.sign(T.x - P.x) === Math.sign(want[actor]) : (T.x - P.x) * Math.sin((want[actor] * Math.PI) / 180) + (T.z - P.z) * Math.cos((want[actor] * Math.PI) / 180) > 0);
      const turnFrames = Math.max(1, Math.round(cdef.defaults.turnTime * fps));
      let walkStart = ip.f0;
      if (!facingOk && !towardPartner) {
        inject(actor, { id: `${ip.id}:face`, action: "turn", start: sec(ip.f0), duration: sec(turnFrames), face: r3(want[actor]) });
        walkStart = ip.f0 + turnFrames;
      }
      holdFrom[actor] = ip.f0;
      if (moving) {
        const apEnd = approach?.f1 ?? ip.f0;
        const frs = apEnd - walkStart;
        const role = def.roles[ip.actors.indexOf(actor)].name;
        if (!approach || frs < 1) {
          err("INTERACTION_INVALID", [...p], `"${actor}" must move ${r3(flat(kind, P, T))} ${kind === "2d" ? "px" : "m"} to stand at the ${def.id} distance, but "${def.id}" has no approach time for it (place the actors first or lengthen the interaction)`, {
            actor,
            requiredPosition: T,
            position: P,
          });
          continue;
        }
        const walk = characterActions(cdef).walk;
        if (!walk || walk.kind !== "locomotion") {
          err("INTERACTION_INCOMPATIBLE", [...p, "actors", ip.actors.indexOf(actor)], `"${actor}" (${cdef.id}) has no walk action to approach for role "${role}" (place it at the interaction distance or use anchor)`, {
            role,
            actor,
            missing: { actions: ["walk"] },
          });
          continue;
        }
        const speed = flat(kind, P, T) / (frs / fps);
        const nominal = (walk.speed ?? (kind === "2d" ? 160 : 1.2)) * (insts[index.get(actor)!].scale ?? 1);
        if (speed > 2.2 * nominal) {
          warn("INTERACTION_FAST_APPROACH", [...p], `"${actor}" must cover ${r3(flat(kind, P, T))} ${kind === "2d" ? "px" : "m"} in the ${r3(frs / fps)}s approach (${r3(speed)} vs walk ${r3(nominal)}); walk it closer first or start the interaction earlier`, {
            actor,
            speed: r3(speed),
            walkSpeed: r3(nominal),
          });
        }
        inject(actor, {
          id: `${ip.id}:approach`,
          action: "walk",
          start: sec(walkStart),
          duration: sec(frs),
          to: kind === "2d" ? { x: r3(T.x), y: r3(T.y) } : { x: r4(T.x), z: r4(T.z) },
          ...(towardPartner ? {} : { keepFacing: true }),
        });
        holdFrom[actor] = apEnd;
      }
      ip.alignment[actor] = { from: P, to: T, facing: r3(want[actor]), walks: moving };
    }
    if (errors.length) return out;
    addMoves({ [A]: TA, [B]: TB }, want);
    for (const a of [A, B]) holds(a, holdFrom[a]);
  }
  if (errors.length) return out;

  // --- 3. final plans
  for (const inst of insts) {
    const r = planOf(inst.id);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    if (r.plan) out.plans[inst.id] = r.plan;
  }
  if (errors.length) return out;
  const plans = out.plans;
  const pos = (a: string, f: number) => positionAt(plans[a], f);
  const face = (a: string, f: number) => facingAt(plans[a], f);

  // --- 4. object holdings and transfers (frame order)
  const holdings: Holding[] = [];
  for (const inst of insts) {
    for (const pr of inst.props ?? []) {
      const hand = pr.socket === "rightHand" ? "right" : pr.socket === "leftHand" ? "left" : null;
      holdings.push({ actor: inst.id, object: pr.id, layer: `${inst.id}.${pr.id}`, hand, own: true, from: Math.round((pr.visibleFrom ?? 0) * fps), until: Infinity });
    }
  }
  const usedIds = new Set<string>(holdings.map((h) => h.layer));
  for (const inst of insts) {
    const def = out.defs[inst.id];
    if (def.kind === "2d") for (const part of def.rig.parts) usedIds.add(`${inst.id}.${part.id}`);
  }
  const objectHand: Record<string, Hand> = {};
  for (const ip of [...ixs].sort((a, b) => transferFrame(a) - transferFrame(b))) {
    const t = ip.def.transfer;
    if (!t) continue;
    const p = ["interactions", ip.index];
    const giver = ip.roles[t.from];
    const receiver = ip.roles[t.to];
    const object = ip.params.object;
    const ft = transferFrame(ip);
    if (!object) continue; // reported as a missing param
    const h = holdings.find((x) => x.actor === giver && x.object === object && x.from <= ft && ft < x.until);
    if (!h) {
      err("INTERACTION_OBJECT_NOT_HELD", [...p, "params", "object"], `"${giver}" does not hold "${object}" at ${r3(ft / fps)}s (it can only give its own props or objects it received before)`, {
        object,
        giver,
        holds: holdings.filter((x) => x.actor === giver && x.from <= ft && ft < x.until).map((x) => x.object),
      });
      continue;
    }
    if (!h.hand) {
      err("INTERACTION_INCOMPATIBLE", [...p, "params", "object"], `"${object}" is not held in a hand of "${giver}" (socket must be rightHand or leftHand)`, { object, giver });
      continue;
    }
    if (!dimsOf(giver).arms[h.hand]) {
      err("INTERACTION_INCOMPATIBLE", [...p, "params", "object"], `"${giver}" holds "${object}" in its ${h.hand} hand, which cannot reach: ${dimsOf(giver).armIssues[h.hand]}`, { object, giver });
      continue;
    }
    const recvEff = ip.def.effectors.find((e) => e.role === t.to);
    const receiverHand: Hand = (recvEff && effectorHand(recvEff, ip.params)) || ip.params.hand || "right";
    h.until = ft;
    let toLayer = `${receiver}.${object}`;
    if (usedIds.has(toLayer)) toLayer = `${receiver}.${object}_${ip.id}`;
    usedIds.add(toLayer);
    const received: Holding = { actor: receiver, object, layer: toLayer, hand: receiverHand, own: false, from: ft, until: Infinity, ix: ip.id, prev: h };
    holdings.push(received);
    objectHand[ip.id] = h.hand;
    out.transfers.push({ ix: ip.id, object, from: giver, to: receiver, frame: ft, fromLayer: h.layer, toLayer, giverHand: h.hand, receiverHand, given: h, received });
  }
  if (errors.length) return out;
  out.holdings = holdings;
  for (const h of holdings) if (h.own && h.until !== Infinity) (out.hideProps[h.actor] ??= {})[h.object] = h.until;

  // --- 5. reaches
  for (const ip of ixs) {
    const def = ip.def;
    const p = ["interactions", ip.index];
    const phase = (n: string) => ip.phases.find((x) => x.name === n)!;
    const [a0, a1] = ip.actors;
    const targetAt = (name: string, f: number): V3 => {
      const t = def.targets[name];
      if (t.kind === "between") {
        const P0 = pos(a0, f);
        const P1 = pos(a1, f);
        const u = t.along === "reach" ? ip.along : t.along;
        let h = evalHeight(t.height, [dimsOf(a0), dimsOf(a1)]);
        if (t.shake) {
          const ph = phase(t.shake.phase);
          if (f >= ph.f0 && f < ph.f1 && ph.f1 > ph.f0) {
            const k = (f - ph.f0) / (ph.f1 - ph.f0);
            h += t.shake.amplitude * ((dimsOf(a0).height + dimsOf(a1).height) / 2) * Math.sin((2 * Math.PI * t.shake.frequency * (f - ph.f0)) / fps) * Math.sin(Math.PI * k);
          }
        }
        return kind === "2d"
          ? { x: P0.x + (P1.x - P0.x) * u, y: (P0.y + P1.y) / 2 - h, z: 0 }
          : { x: P0.x + (P1.x - P0.x) * u, y: (P0.y + P1.y) / 2 + h, z: P0.z + (P1.z - P0.z) * u };
      }
      const partner = ip.roles[t.of];
      const dp = dimsOf(partner);
      return toWorld(kind, pos(partner, f), face(partner, f), { forward: t.forward * dp.height, up: evalHeight(t.height, [dp]), lateral: t.lateral * dp.height });
    };
    for (const e of def.effectors) {
      const actor = ip.roles[e.role];
      const hand = effectorHand(e, ip.params) ?? objectHand[ip.id] ?? "right";
      const arm = dimsOf(actor).arms[hand];
      if (!arm) continue; // reported by the compatibility check
      const from = phase(e.from);
      const until = phase(e.until);
      const weights = new Array<number>(frames).fill(0);
      const targets = new Array<V3>(frames);
      const lo = from.f0;
      const hi = Math.min(ip.f1, frames);
      for (let f = 0; f < frames; f++) {
        const ff = Math.min(Math.max(f, lo), Math.max(lo, hi - 1));
        targets[f] = targetAt(e.target, ff);
        if (f < from.f0 || f >= ip.f1) continue;
        if (f < from.f1) weights[f] = from.f1 - from.f0 > 1 ? smooth((f - from.f0) / (from.f1 - from.f0 - 1)) : 1;
        else if (f < until.f0) weights[f] = 1;
        else weights[f] = 1 - smooth((f - until.f0) / Math.max(1, ip.f1 - until.f0 - 1));
      }
      // predicted miss while in contact (rest-pose shoulder)
      let miss = 0;
      for (let f = from.f1; f < Math.min(until.f0 + 1, frames); f++) {
        const S = toWorld(kind, pos(actor, f), face(actor, f), arm.shoulder);
        miss = Math.max(miss, dist3(S, targets[f]) - arm.reach);
      }
      const claims = kind === "2d" ? [arm.upper, arm.lower, arm.end] : [`arm.${hand}`];
      const reach: ReachPlan = {
        ix: ip.id,
        actor,
        role: e.role,
        target: e.target,
        hand,
        upper: arm.upper,
        lower: arm.lower,
        end: arm.end,
        ...(arm.point ? { point: arm.point } : {}),
        grip: arm.grip,
        weights,
        targets,
        ...(e.handPose ? { handPose: e.handPose } : {}),
        f0: from.f0,
        contactF0: from.f1,
        contactF1: until.f0,
        f1: ip.f1,
        claims,
        predictedMiss: r4(Math.max(0, miss)),
      };
      const dh = dimsOf(actor).height;
      if (reach.predictedMiss > 0.02 * dh) {
        warn("INTERACTION_OUT_OF_REACH", [...p], `"${actor}"'s ${hand} hand stays ~${r3(reach.predictedMiss)} ${kind === "2d" ? "px" : "m"} short of the "${e.target}" target (arm too short for this pose)`, {
          actor,
          hand,
          target: e.target,
          miss: reach.predictedMiss,
        });
      }
      // conflicts: gestures using the arm, other reaches on the same arm
      const overlap = (a0f: number, a1f: number, b0: number, b1: number) => a0f < b1 && b0 < a1f;
      const rid = `${ip.id}:${hand}Arm`;
      for (const g of plans[actor].gestures) {
        const shared = kind === "3d" ? (g.claims.includes("body") ? claims : []) : g.claims.filter((c) => claims.includes(c));
        if (shared.length && overlap(g.f0, g.f1, reach.f0, reach.f1)) {
          err("ACTION_CONFLICT", [...p], `Action "${g.actionId}" of "${actor}" overlaps interaction "${ip.id}" on its ${hand} arm`, {
            actions: [g.actionId, rid],
            channel: "body-part",
            parts: shared,
            instance: actor,
            interactions: [ip.id],
            ...(kind === "3d" ? { rule: "3D gestures play a full-body clip; they cannot overlap an interaction's reach" } : {}),
          });
        }
      }
      for (const other of out.reaches[actor] ?? []) {
        if (other.hand === hand && overlap(other.f0, other.f1, reach.f0, reach.f1)) {
          err("ACTION_CONFLICT", [...p], `Interactions "${other.ix}" and "${ip.id}" both use the ${hand} arm of "${actor}" at the same time`, {
            actions: [`${other.ix}:${hand}Arm`, rid],
            channel: "body-part",
            instance: actor,
            interactions: [other.ix, ip.id],
          });
        }
      }
      (out.reaches[actor] ??= []).push(reach);
    }
    // character turns inside the interaction would break the alignment
    for (const actor of ip.actors) {
      for (const [aid, info] of Object.entries(plans[actor].resolved)) {
        if (info.action !== "turn" || info.source) continue;
        const s0 = info.startFrame as number;
        const s1 = info.endFrame as number;
        if (s0 < ip.f1 && ip.f0 < s1) {
          err("ACTION_CONFLICT", [...p], `Action "${aid}" (turn) of "${actor}" overlaps interaction "${ip.id}", which controls its facing`, { actions: [aid, `${ip.id}:face`], channel: "facing", instance: actor, interactions: [ip.id] });
        }
      }
    }
  }
  out.interactions = ixs;
  out.ok = errors.length === 0;
  return out;

  function transferFrame(ip: InteractionPlan): number {
    const t = ip.def.transfer;
    return t ? ip.phases.find((x) => x.name === t.at)!.f0 : Infinity;
  }
}

// ---- object copies for transfers ------------------------------------------------------------------

type M3 = number[][];
const mul3 = (a: M3, b: M3): M3 => a.map((row) => [0, 1, 2].map((j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]));
const rx = (d: number): M3 => {
  const r = (d * Math.PI) / 180;
  return [
    [1, 0, 0],
    [0, Math.cos(r), -Math.sin(r)],
    [0, Math.sin(r), Math.cos(r)],
  ];
};
const ry = (d: number): M3 => {
  const r = (d * Math.PI) / 180;
  return [
    [Math.cos(r), 0, Math.sin(r)],
    [0, 1, 0],
    [-Math.sin(r), 0, Math.cos(r)],
  ];
};
const rz = (d: number): M3 => {
  const r = (d * Math.PI) / 180;
  return [
    [Math.cos(r), -Math.sin(r), 0],
    [Math.sin(r), Math.cos(r), 0],
    [0, 0, 1],
  ];
};
/** Euler XYZ (degrees; X applied first, the backend's convention) <-> matrix. */
const eulerM = (e: V3): M3 => mul3(rz(e.z), mul3(ry(e.y), rx(e.x)));
function mEuler(m: M3): V3 {
  const deg = (v: number) => (v * 180) / Math.PI;
  const sy = Math.max(-1, Math.min(1, -m[2][0]));
  return { x: r3(deg(Math.atan2(m[2][1], m[2][2]))), y: r3(deg(Math.asin(sy))), z: r3(deg(Math.atan2(m[1][0], m[0][0]))) };
}
const mv = (m: M3, v: V3): V3 => ({ x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z, y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z, z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z });

function decompose2D(m: Mat2D) {
  const sx = Math.hypot(m.a, m.b);
  const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  const sy = (m.a * m.d - m.b * m.c) / (sx || 1);
  return { x: r3(m.e), y: r3(m.f), rotation: r3(rot), scaleX: r4(sx), scaleY: r4(sy) };
}

function visibilityTrack(owner: string, target: string, from: number, until: number, frames: number) {
  const keys: { frame: number; value: boolean; interpolation: "step" }[] = [];
  if (from > 0) keys.push({ frame: 0, value: false, interpolation: "step" });
  keys.push({ frame: Math.min(from, frames - 1), value: true, interpolation: "step" });
  if (until < frames) keys.push({ frame: until, value: false, interpolation: "step" });
  return { target, property: "visible", owner, keyframes: keys };
}

/**
 * Layers (2D) / objects (3D) showing transferred objects in the receivers' hands, plus their
 * visibility tracks; each owned by its receiver. `compiled` are the actors' compilations (2D:
 * their fk is used to place the copy exactly where the given object was).
 */
export function transferCopies(doc: SceneDoc, sp: ScenePlan, compiled: Record<string, CompiledCharacter>) {
  const kind: "2d" | "3d" = is3D(doc) ? "3d" : "2d";
  const frames: number = doc.duration;
  const insts = new Map(((doc.characters ?? []) as CharacterInstance[]).map((c) => [c.id, c]));
  const items: { owner: string; entity: Record<string, unknown>; track: ReturnType<typeof visibilityTrack> }[] = [];
  const warnings: ValidationIssue[] = [];
  // per holding: what it shows (2D: matrix relative to the hand pivot; 3D: attach offsets)
  const local2D = new Map<Holding, { part: string; L: Mat2D; asset: string; z: number }>();
  const local3D = new Map<Holding, { pos: V3; rot: V3; scale: number; asset: string; follow: "full" | "position" }>();
  const propOf = (h: Holding) => insts.get(h.actor)!.props!.find((p) => p.id === h.object)!;
  const baseProp = (h: Holding): ReturnType<typeof propOf> => (h.own ? propOf(h) : baseProp(h.prev!));
  for (const t of sp.transfers) {
    const g = t.given;
    const rcv = t.received;
    const ft = t.frame;
    const prop = baseProp(g);
    if (kind === "2d") {
      const gDef = sp.defs[g.actor] as Character2D;
      const rDef = sp.defs[rcv.actor] as Character2D;
      let gl = local2D.get(g);
      if (!gl) {
        const sock = gDef.sockets[prop.socket];
        const part = gDef.rig.parts.find((x) => x.id === sock.part)!;
        const off = pointInPart(part, sock.point);
        gl = { part: part.id, asset: prop.asset, z: part.z, L: compose(translate(off.x, off.y), translate(prop.x ?? 0, prop.y ?? 0), rotateDeg(prop.rotation ?? 0), scaleM(prop.scale ?? 1, prop.scale ?? 1)) };
        local2D.set(g, gl);
      }
      const world = multiply(compiled[g.actor].fk!(gl.part, ft), gl.L);
      const sock = rDef.sockets[HAND_SOCKET[t.receiverHand]];
      const rPart = rDef.rig.parts.find((x) => x.id === sock.part)!;
      const HB = compiled[rcv.actor].fk!(rPart.id, ft);
      const inv = invert(HB);
      if (!inv) continue;
      const Lfull = multiply(inv, world);
      local2D.set(rcv, { part: rPart.id, L: Lfull, asset: gl.asset, z: rPart.z });
      const off = pointInPart(rPart, sock.point);
      const local = decompose2D(multiply(translate(-off.x, -off.y), Lfull));
      const baseZ = insts.get(rcv.actor)!.z ?? 10;
      items.push({
        owner: rcv.actor,
        entity: {
          id: rcv.layer,
          asset: gl.asset,
          parent: `${rcv.actor}.${rPart.id}`,
          ...(sock.point ? { parentPoint: sock.point } : {}),
          ...local,
          z: r3(baseZ + (rPart.z + 0.5) / 100),
          meta: { character: rcv.actor, generated: true, prop: rcv.object, receivedFrom: g.actor, interaction: t.ix },
        },
        track: visibilityTrack(rcv.actor, rcv.layer, rcv.from, rcv.until, frames),
      });
    } else {
      const reachOf = (actor: string, hand: Hand) => sp.reaches[actor]?.find((r) => r.ix === t.ix && r.hand === hand);
      const head = (actor: string, hand: Hand): V3 | null => {
        const r = reachOf(actor, hand);
        const arm = sp.dims[actor].arms[hand];
        if (!r || !arm) return null;
        const T = r.targets[ft];
        const S = toWorld("3d", positionAt(sp.plans[actor], ft), facingAt(sp.plans[actor], ft), arm.shoulder);
        const d = dist3(T, S) || 1;
        return { x: T.x - (arm.grip * (T.x - S.x)) / d, y: T.y - (arm.grip * (T.y - S.y)) / d, z: T.z - (arm.grip * (T.z - S.z)) / d };
      };
      let gl = local3D.get(g);
      if (!gl) {
        gl = { pos: { x: 0, y: 0, z: 0, ...prop.position }, rot: { x: 0, y: 0, z: 0, ...prop.rotation3 }, scale: prop.scale ?? 1, asset: prop.asset, follow: prop.follow ?? "full" };
        local3D.set(g, gl);
        if (gl.follow === "full") {
          warnings.push({
            severity: "warning",
            code: "TRANSFER_ORIENTATION_APPROX",
            path: ["interactions"],
            message: `"${prop.id}" follows the hand bone fully; the received copy keeps the giver's upright orientation instead (use follow:"position" on props that are handed over for an exact match)`,
          });
        }
      }
      const hA = head(g.actor, t.giverHand);
      const hB = head(rcv.actor, t.receiverHand);
      if (!hA || !hB) continue;
      const sA = (insts.get(g.actor)!.scale ?? 1) * (sp.defs[g.actor] as Character3D).scale;
      const sB = (insts.get(rcv.actor)!.scale ?? 1) * (sp.defs[rcv.actor] as Character3D).scale;
      const yA = facingAt(sp.plans[g.actor], ft);
      const yB = facingAt(sp.plans[rcv.actor], ft);
      const offA = mv(ry(yA), gl.pos);
      const worldPos = { x: hA.x + sA * offA.x, y: hA.y + sA * offA.y, z: hA.z + sA * offA.z };
      const lp = mv(ry(-yB), { x: (worldPos.x - hB.x) / sB, y: (worldPos.y - hB.y) / sB, z: (worldPos.z - hB.z) / sB });
      const rot = mEuler(mul3(ry(yA - yB), eulerM(gl.rot)));
      const scale = (gl.scale * sA) / sB;
      local3D.set(rcv, { pos: lp, rot, scale, asset: gl.asset, follow: "position" });
      const rDef = sp.defs[rcv.actor] as Character3D;
      const socket = HAND_SOCKET[t.receiverHand];
      items.push({
        owner: rcv.actor,
        entity: {
          id: rcv.layer,
          asset: gl.asset,
          attach: { object: rcv.actor, bone: rDef.sockets?.[socket] ?? socket, follow: "position" },
          position: { x: r4(lp.x), y: r4(lp.y), z: r4(lp.z) },
          rotation: rot,
          ...(Math.abs(scale - 1) > 1e-6 ? { scale: { x: r4(scale), y: r4(scale), z: r4(scale) } } : {}),
          meta: { character: rcv.actor, generated: true, prop: rcv.object, receivedFrom: g.actor, interaction: t.ix },
        },
        track: visibilityTrack(rcv.actor, rcv.layer, rcv.from, rcv.until, frames),
      });
    }
  }
  return { items, warnings };
}

// ---- discovery -----------------------------------------------------------------------------------

/** Channels an interaction takes over for its actors, and what keeps working alongside it. */
export function interactionChannels(def: InteractionDefinition) {
  const perRole = Object.fromEntries(
    def.roles.map((r) => {
      const hands = def.effectors.filter((e) => e.role === r.name).map((e) => (e.hand === "param" ? "right (params.hand)" : e.hand === "object" ? "hand holding params.object" : e.hand));
      return [r.name, { locomotion: true, facing: true, arms: [...new Set(hands)] }];
    }),
  );
  return {
    owns: perRole,
    concurrent: ["mouth (talk)", "expression (smile, ...)", "eyes (blink, autoBlink)", "gestures on arms the interaction does not use (2D)"],
    note: "During the interaction its actors cannot walk, run or turn on their own (ACTION_CONFLICT); in 3D gestures (full-body clips) cannot overlap its reach.",
  };
}

export function describeInteraction(def: InteractionDefinition, sha: string, builtin: boolean) {
  return {
    id: def.id,
    name: def.name ?? def.id,
    description: def.description ?? "",
    builtin,
    sha256: sha,
    actors: def.roles.length,
    roles: def.roles.map((r) => ({ name: r.name, description: r.description ?? "", requires: { actions: r.requires.actions, sockets: r.requires.sockets, arms: [...new Set(def.effectors.filter((e) => e.role === r.name).map((e) => e.hand))] } })),
    duration: def.duration,
    params: {
      ...def.params,
      anchor: { type: "string", required: false, description: `first | second | midpoint: who stays in place (default ${def.alignment.anchor})` },
      hand: { type: "string", required: false, description: "right | left for one-hand roles (default right)" },
    },
    phases: def.phases,
    alignment: def.alignment,
    targets: def.targets,
    effectors: def.effectors,
    moves: def.moves,
    ...(def.transfer ? { transfer: def.transfer } : {}),
    channels: interactionChannels(def),
  };
}

/**
 * Whether the given characters can play the interaction's roles (in role order), and how they
 * would fit: required actions/sockets/arms per role, the face-to-face distance and target height
 * the runtime would use, and whether each hand reaches (different sizes adapt; reports limits).
 */
export function checkInteraction(
  def: InteractionDefinition,
  actors: { id: string; def: CharacterDefinition; scale?: number; props?: CharacterInstance["props"] }[],
  lookups: Pick<InteractionLookups, "model">,
  params: InteractionInstance["params"] = {},
) {
  const issues: { role: string; actor: string; problem: string }[] = [];
  if (actors.length !== def.roles.length) {
    return { compatible: false, issues: [{ role: "*", actor: "*", problem: `needs ${def.roles.length} actors (${def.roles.map((r) => r.name).join(", ")}), got ${actors.length}` }], roles: [], fit: null };
  }
  const kinds = new Set(actors.map((a) => a.def.kind));
  if (kinds.size > 1) issues.push({ role: "*", actor: "*", problem: "2D and 3D characters cannot interact (they live in different scenes)" });
  const dims = actors.map((a) => actorDims(a.def, { scale: a.scale }, a.def.kind === "3d" ? lookups.model?.(a.def.model) : undefined));
  const roles = def.roles.map((role, i) => {
    const a = actors[i];
    const supported = characterActions(a.def);
    const d = dims[i];
    const actions = role.requires.actions.map((x) => ({ action: x, available: !!supported[x], ...(x === "walk" ? { note: "needed only when it must approach" } : {}) }));
    const hands = def.effectors
      .filter((e) => e.role === role.name)
      .map((e) => {
        let hand = effectorHand(e, params);
        if (!hand) {
          const pr = a.props?.find((p) => p.id === params?.object);
          hand = pr?.socket === "leftHand" ? "left" : "right";
        }
        return { hand, target: e.target, available: !!d.arms[hand], ...(d.arms[hand] ? {} : { problem: d.armIssues[hand] }) };
      });
    for (const x of actions) if (!x.available && x.action !== "walk") issues.push({ role: role.name, actor: a.id, problem: `missing action ${x.action}` });
    for (const h of hands) if (!h.available) issues.push({ role: role.name, actor: a.id, problem: `${h.hand} arm: ${h.problem}` });
    return { role: role.name, actor: a.id, character: a.def.id, kind: a.def.kind, height: d.height, arms: d.arms, actions, hands };
  });
  // fit (face to face)
  let fit: Record<string, unknown> | null = null;
  if (def.alignment.mode === "face_to_face" && dims.length === 2 && kinds.size === 1) {
    const between = Object.values(def.targets).find((t) => t.kind === "between") as Extract<TargetSpec, { kind: "between" }> | undefined;
    const hT = evalHeight(def.alignment.height ?? between?.height, dims);
    const reachRoles = def.alignment.distance.roles ?? [...new Set(def.effectors.filter((e) => def.targets[e.target]?.kind === "between").map((e) => e.role))];
    let D = 0;
    const reach: Record<string, { reachesTargetHeight: boolean; forward: number }> = {};
    for (const role of reachRoles) {
      const i = def.roles.findIndex((r) => r.name === role);
      const arm = armOf(dims[i], "right");
      if (!arm) continue;
      const fr = forwardReach(arm, hT, def.alignment.distance.reach);
      reach[role] = { reachesTargetHeight: fr.ok, forward: r4(fr.fwd) };
      D += fr.fwd;
      if (!fr.ok) issues.push({ role, actor: actors[i].id, problem: `arm too short for the target height (${r3(hT)}); the hand stops short (warning, not an error)` });
    }
    const avgH = (dims[0].height + dims[1].height) / 2;
    D = Math.max(D + def.alignment.distance.height * avgH, 0.05 * avgH);
    fit = {
      distance: r4(D),
      targetHeight: r4(hT),
      unit: dims[0].kind === "2d" ? "px" : "m",
      heightRatio: r3(Math.min(dims[0].height, dims[1].height) / Math.max(dims[0].height, dims[1].height)),
      reach,
      note: "distance = feet to feet when aligned; targets adapt to each actor's shoulder height and arm length",
    };
  }
  const blocking = issues.filter((x) => !x.problem.includes("(warning"));
  return { compatible: blocking.length === 0, issues, roles, fit, channels: interactionChannels(def) };
}

// ---- inspection ------------------------------------------------------------------------------------

/** Active phase (and progress 0..1) of an interaction at a frame, or null outside it. */
export function phaseAt(ip: InteractionPlan, f: number) {
  if (f < ip.f0 || f >= ip.f1) return null;
  const ph = ip.phases.find((x) => f >= x.f0 && f < x.f1) ?? ip.phases[ip.phases.length - 1];
  return { name: ph.name, progress: r3(ph.f1 > ph.f0 ? (f - ph.f0) / (ph.f1 - ph.f0) : 1) };
}

/**
 * The resolved interaction schedule: per interaction its actors/roles, phases (seconds and frames),
 * alignment (where each actor starts, where it stands, facing), injected actions, reach windows and
 * contact targets, predicted reach misses, the object transfer and ownership history. With `frame`:
 * the state at that frame (active phases, actor positions, hand targets and weights, who holds each
 * object).
 */
export function interactionTimeline(doc: SceneDoc, ctx: InteractionLookups, frame?: number) {
  const sp = planScene(doc, ctx);
  const fps: number = doc.canvas.fps;
  const s = (f: number) => r3(f / fps);
  const vec = (v: V3) => (is3D(doc) ? { x: r4(v.x), y: r4(v.y), z: r4(v.z) } : { x: r3(v.x), y: r3(v.y) });
  const list = interactionList(doc);
  const interactions = sp.interactions
    .sort((a, b) => a.f0 - b.f0)
    .map((ip) => {
      const stored = list[ip.index];
      const tr = sp.transfers.find((t) => t.ix === ip.id);
      const reaches = Object.values(sp.reaches)
        .flat()
        .filter((r) => r.ix === ip.id);
      const mid = (r: ReachPlan) => Math.min(doc.duration - 1, Math.round((r.contactF0 + r.contactF1) / 2));
      return {
        id: ip.id,
        interaction: ip.interaction,
        actors: ip.actors,
        roles: ip.roles,
        params: ip.params,
        start: s(ip.f0),
        end: s(ip.f1),
        startFrame: ip.f0,
        endFrame: ip.f1,
        stale: stored.definitionSha !== undefined && stored.definitionSha !== ip.sha,
        phases: ip.phases.map((p) => ({ name: p.name, start: s(p.f0), end: s(p.f1), startFrame: p.f0, endFrame: p.f1 })),
        alignment: {
          anchor: ip.anchor ?? null,
          distance: ip.distance ?? null,
          actors: Object.fromEntries(Object.entries(ip.alignment).map(([a, x]) => [a, { from: vec(x.from), to: vec(x.to), facing: x.facing, walks: x.walks }])),
        },
        injectedActions: ip.injected,
        contacts: reaches.map((r) => ({
          actor: r.actor,
          role: r.role,
          hand: r.hand,
          target: r.target,
          reachStart: s(r.f0),
          contactStart: s(r.contactF0),
          contactEnd: s(r.contactF1),
          end: s(r.f1),
          targetAtContact: vec(r.targets[mid(r)]),
          predictedMiss: r.predictedMiss,
        })),
        ...(tr ? { transfer: { object: tr.object, from: tr.from, to: tr.to, at: s(tr.frame), frame: tr.frame, fromLayer: tr.fromLayer, toLayer: tr.toLayer, giverHand: tr.giverHand, receiverHand: tr.receiverHand } } : {}),
      };
    });
  const objects: Record<string, { actor: string; layer: string; from: number; until: number | null }[]> = {};
  const chainOf = (h: Holding): Holding => (h.prev ? chainOf(h.prev) : h);
  for (const h of sp.holdings) {
    const root = chainOf(h);
    const key = `${root.actor}.${root.object}`;
    (objects[key] ??= []).push({ actor: h.actor, layer: h.layer, from: s(h.from), until: h.until === Infinity ? null : s(h.until) });
  }
  const result: {
    interactions: typeof interactions;
    objects: { object: string; owners: { actor: string; layer: string; from: number; until: number | null }[] }[];
    issues: Record<string, unknown>[];
    atFrame?: Record<string, unknown>;
  } = {
    interactions,
    objects: Object.entries(objects).map(([object, holders]) => ({ object, owners: holders.sort((a, b) => a.from - b.from) })),
    issues: [...sp.errors, ...sp.warnings].map(({ severity, code, message, details }) => ({ severity, code, message, ...(details ? { details } : {}) })),
  };
  if (frame !== undefined && sp.ok) {
    result.atFrame = {
      frame,
      time: s(frame),
      interactions: sp.interactions.map((ip) => ({ id: ip.id, phase: phaseAt(ip, frame) })).filter((x) => x.phase),
      actors: Object.fromEntries(Object.entries(sp.plans).map(([a, p]) => [a, { position: vec(positionAt(p, frame)), facing: r3(facingAt(p, frame)) }])),
      hands: Object.values(sp.reaches)
        .flat()
        .filter((r) => r.weights[frame] > 0)
        .map((r) => ({ ix: r.ix, actor: r.actor, hand: r.hand, target: r.target, weight: r3(r.weights[frame]), targetPosition: vec(r.targets[frame]) })),
      owners: Object.fromEntries(
        Object.entries(objects).map(([k]) => {
          const h = sp.holdings.find((x) => `${chainOf(x).actor}.${chainOf(x).object}` === k && x.from <= frame && frame < x.until);
          return [k, h ? { actor: h.actor, layer: h.layer } : null];
        }),
      ),
    };
  }
  return { ...result, plan: sp };
}

export { interactionSha };
