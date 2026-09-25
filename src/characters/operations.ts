/**
 * Character operations on scene documents (2D and 3D). Same contract as every other scene
 * operation: pure, transactional, machine-readable issues. After each change the affected
 * instances are recompiled: everything they previously generated (layers/objects with
 * meta.character = id, tracks and audio with owner = id) is replaced by the new compilation.
 * Hand-authored content is never touched.
 */
import { issue, is3D, transact, zodIssues, type OpResult, type SceneDoc } from "../api/operations.js";
import type { ValidationIssue } from "../scene/validate.js";
import { compile2D, compile3D } from "./compile.js";
import { characterActions, planCharacter, type Plan } from "./plan.js";
import {
  CharacterActionSchema,
  CharacterInstanceSchema,
  CharacterPropSchema,
  type CharacterAction,
  type CharacterDefinition,
  type CharacterInstance,
  type SpeechTiming,
} from "./schema.js";
import { z } from "zod";

export interface CharacterContext {
  /** Prepared character definition (asset names already mapped to workspace asset ids). */
  definition(id: string): { def: CharacterDefinition; sha: string } | undefined;
  speech?(id: string): SpeechTiming | undefined;
  /** Workspace-relative file of an audio asset (2D/3D scene audio entries use files). */
  audioSrc?(assetId: string): string | undefined;
}

const clone = <T>(v: T): T => structuredClone(v);

export function instances(doc: SceneDoc): CharacterInstance[] {
  return (doc.characters ?? []) as CharacterInstance[];
}

function removeGenerated(d: SceneDoc, id: string) {
  const mine = (x: any) => x?.meta?.character === id;
  if (is3D(d)) d.objects = (d.objects ?? []).filter((o: any) => !mine(o));
  else d.layers = (d.layers ?? []).filter((l: any) => !mine(l));
  d.animations = (d.animations ?? []).filter((a: any) => a.owner !== id);
  d.audio = (d.audio ?? []).filter((a: any) => a.owner !== id);
}

export interface CompileInfo {
  plan: Plan;
  warnings: ValidationIssue[];
}

/** Recompiles one instance inside `d` (mutates). Returns issues on failure. */
function compileInstance(d: SceneDoc, index: number, ctx: CharacterContext): { errors: ValidationIssue[]; warnings: ValidationIssue[]; plan?: Plan } {
  const inst = d.characters[index] as CharacterInstance;
  const p: (string | number)[] = ["characters", index];
  const entry = ctx.definition(inst.character);
  if (!entry) return { errors: [issue("CHARACTER_NOT_FOUND", [...p, "character"], `No prepared character "${inst.character}" in this workspace (character_import it first)`)], warnings: [] };
  const { def, sha } = entry;
  const kind = is3D(d) ? "3d" : "2d";
  if (def.kind !== kind) {
    return { errors: [issue("INVALID_ACTION", [...p, "character"], `"${inst.character}" is a ${def.kind.toUpperCase()} character; this is a ${kind.toUpperCase()} scene`)], warnings: [] };
  }
  const r = planCharacter(inst, def, { fps: d.canvas.fps, frames: d.duration, speech: ctx.speech?.bind(ctx) }, p);
  if (!r.ok) return { errors: r.errors, warnings: r.warnings };
  const plan = r.plan!;
  const errors: ValidationIssue[] = [];
  // props need known sockets
  for (const [i, prop] of (inst.props ?? []).entries()) {
    const known = def.kind === "2d" ? Object.keys(def.sockets) : null;
    if (known && !known.includes(prop.socket)) errors.push(issue("BONE_NOT_FOUND", [...p, "props", i, "socket"], `Character "${def.id}" has no socket "${prop.socket}"`, { sockets: known }));
  }
  if (errors.length) return { errors, warnings: r.warnings };
  removeGenerated(d, inst.id);
  const compiled =
    def.kind === "2d"
      ? compile2D(plan, def, inst, { assetId: (name) => def.assets[name] ?? name })
      : compile3D(plan, def, inst, { modelAsset: def.model, idleClip: characterActions(def).idle?.clip ?? null });
  if (def.kind === "2d") d.layers = [...(d.layers ?? []), ...compiled.layers!];
  else d.objects = [...(d.objects ?? []), ...compiled.objects!];
  d.animations = [...(d.animations ?? []), ...compiled.tracks];
  for (const a of compiled.audio) {
    const src = ctx.audioSrc?.(a.asset);
    if (!src) {
      errors.push(issue("ASSET_NOT_FOUND", [...p, "actions"], `Speech audio asset "${a.asset}" is not an audio asset of this workspace`));
      continue;
    }
    d.audio = [...(d.audio ?? []), { src, startFrame: a.startFrame, volume: a.volume ?? 1, owner: inst.id }];
  }
  (d.characters[index] as CharacterInstance).definitionSha = sha;
  return { errors, warnings: r.warnings, plan };
}

/** Runs `mutate`, then recompiles `ids` (all when omitted), all inside one validated transaction. */
function withCompile<T>(doc: SceneDoc, ctx: CharacterContext, mutate: (d: SceneDoc) => T | { errors: ValidationIssue[] }, ids?: () => string[]): OpResult<T & { plans?: Record<string, Plan> }> {
  let failure: ValidationIssue[] | null = null;
  let warnings: ValidationIssue[] = [];
  const r = transact(doc, (d) => {
    const out = mutate(d);
    if (out && typeof out === "object" && "errors" in (out as any) && Array.isArray((out as any).errors)) {
      failure = (out as any).errors;
      return undefined as any;
    }
    const plans: Record<string, Plan> = {};
    const want = ids ? ids() : instances(d).map((x) => x.id);
    for (const id of want) {
      const idx = instances(d).findIndex((x) => x.id === id);
      if (idx < 0) continue;
      const c = compileInstance(d, idx, ctx);
      if (c.errors.length) {
        failure = c.errors;
        return undefined as any;
      }
      warnings = [...warnings, ...c.warnings];
      if (c.plan) plans[id] = c.plan;
    }
    return { ...(out as object), plans } as any;
  });
  if (failure) return { ok: false, errors: failure };
  if (!r.ok) return r as OpResult<any>;
  return { ...r, warnings: [...r.warnings, ...warnings] } as any;
}

const idTaken = (d: SceneDoc, id: string) =>
  (is3D(d) ? [...(d.objects ?? []), ...(d.lights ?? [])] : d.layers ?? []).some((x: any) => x.id === id || x.id.startsWith(id + ".")) ||
  instances(d).some((c) => c.id === id);

// ------------------------------------------------------------------------------------------------

export function addCharacter(doc: SceneDoc, instance: unknown, ctx: CharacterContext): OpResult<{ id: string; plans?: Record<string, Plan> }> {
  const p = CharacterInstanceSchema.safeParse(instance);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["character"]) };
  if (idTaken(doc, p.data.id)) return { ok: false, errors: [issue("DUPLICATE_LAYER_ID", ["character", "id"], `Id "${p.data.id}" is already used in this scene`)] };
  const inst = clone(instance as CharacterInstance);
  inst.actions = assignIds(inst.actions ?? []);
  const resolved = resolveSpeech(inst.actions, ctx);
  if (resolved) return { ok: false, errors: resolved };
  return withCompile(doc, ctx, (d) => {
    d.characters = [...instances(d), inst];
    return { id: inst.id };
  }, () => [inst.id]);
}

const InstancePatch = CharacterInstanceSchema.omit({ id: true, character: true, actions: true, definitionSha: true }).partial();

/** Placement / props / blink / scale changes. `null` removes a field. refresh=true only recompiles. */
export function updateCharacter(doc: SceneDoc, id: string, patch: Record<string, unknown>, ctx: CharacterContext): OpResult<{ plans?: Record<string, Plan> }> {
  const idx = instances(doc).findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, errors: [issue("CHARACTER_NOT_FOUND", ["id"], `No character instance "${id}" in this scene`, { instances: instances(doc).map((c) => c.id) })] };
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null));
  const p = InstancePatch.safeParse(clean);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["patch"]) };
  return withCompile(doc, ctx, (d) => {
    const inst = d.characters[idx];
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete inst[k];
      else if (k === "position" && inst.position) inst.position = { ...inst.position, ...(v as object) };
      else inst[k] = clone(v);
    }
    return {};
  }, () => [id]);
}

export function removeCharacter(doc: SceneDoc, id: string): OpResult<{ removed: string }> {
  const idx = instances(doc).findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, errors: [issue("CHARACTER_NOT_FOUND", ["id"], `No character instance "${id}" in this scene`, { instances: instances(doc).map((c) => c.id) })] };
  return transact(doc, (d) => {
    removeGenerated(d, id);
    d.characters = instances(d).filter((c) => c.id !== id);
    if (!d.characters.length) delete d.characters;
    // hand-made layers/objects attached to the character's parts lose that parent
    const gone = (x: string | undefined | null) => !!x && (x === id || x.startsWith(id + "."));
    for (const l of is3D(d) ? d.objects ?? [] : d.layers ?? []) {
      if (gone(l.parent)) delete l.parent, delete l.parentPoint;
      if (l.attach && gone(l.attach.object)) delete l.attach;
    }
    return { removed: id };
  });
}

// ---- action batches ------------------------------------------------------------------------------

export const ActionOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), action: CharacterActionSchema }).strict(),
  z.object({ type: z.literal("update"), id: z.string(), patch: z.record(z.string(), z.unknown()).describe("Action fields to change (start, duration, direction, ...); null removes a field.") }).strict(),
  z.object({ type: z.literal("replace"), id: z.string(), action: CharacterActionSchema.omit({ id: true }) }).strict(),
  z.object({ type: z.literal("remove"), id: z.string() }).strict(),
  z.object({ type: z.literal("shift"), by: z.number(), after: z.number().min(0).optional().describe("Only actions starting at/after this second (default all)."), ids: z.array(z.string()).optional() }).strict(),
  z.object({ type: z.literal("clear"), actions: z.array(z.string()).optional().describe("Only actions with these names (e.g. ['blink']); default all.") }).strict(),
]);
export type ActionOp = z.infer<typeof ActionOpSchema>;

function assignIds(actions: CharacterAction[], existing: CharacterAction[] = []): CharacterAction[] {
  let n = Math.max(0, ...[...existing, ...actions].map((a) => Number(/^a(\d+)$/.exec(a.id ?? "")?.[1] ?? 0)));
  return actions.map((a) => (a.id ? a : { ...a, id: `a${++n}` }));
}

/** Replaces speech ids by an inline copy (kept with speechId) so the scene is self-contained. */
function resolveSpeech(actions: CharacterAction[], ctx: CharacterContext): ValidationIssue[] | null {
  for (const [i, a] of actions.entries()) {
    if (typeof a.speech === "string") {
      const t = ctx.speech?.(a.speech);
      if (!t) return [issue("SPEECH_NOT_FOUND", ["actions", i, "speech"], `No speech timing "${a.speech}" (save it with speech_timing_save)`)];
      a.speechId = a.speech;
      a.speech = clone(t);
    }
  }
  return null;
}

/**
 * Applies action operations to one character instance atomically and recompiles it. A failing
 * operation names operations[i]; a conflict names the two actions and the channel.
 */
export function applyCharacterActions(doc: SceneDoc, instanceId: string, ops: unknown[], ctx: CharacterContext): OpResult<{ actions: CharacterAction[]; plans?: Record<string, Plan> }> {
  const idx = instances(doc).findIndex((c) => c.id === instanceId);
  if (idx < 0) return { ok: false, errors: [issue("CHARACTER_NOT_FOUND", ["character"], `No character instance "${instanceId}" in this scene`, { instances: instances(doc).map((c) => c.id) })] };
  let actions = clone(instances(doc)[idx].actions ?? []);
  for (let i = 0; i < ops.length; i++) {
    const fail = (errors: ValidationIssue[]) => ({ ok: false as const, errors: errors.map((e) => ({ ...e, path: ["operations", i, ...e.path], details: { ...e.details, opIndex: i } })) });
    const parsed = ActionOpSchema.safeParse(ops[i]);
    if (!parsed.success) return fail(zodIssues(parsed.error, []));
    const op = parsed.data;
    const find = (id: string) => actions.findIndex((a) => a.id === id);
    const notFound = (id: string) => fail([issue("ACTION_NOT_FOUND", ["id"], `No action "${id}" on "${instanceId}"`, { actions: actions.map((a) => `${a.id}:${a.action}`) })]);
    switch (op.type) {
      case "add": {
        if (op.action.id && find(op.action.id) >= 0) return fail([issue("INVALID_ACTION", ["action", "id"], `Action id "${op.action.id}" already exists`)]);
        const [a] = assignIds([clone(op.action)], actions);
        const r = resolveSpeech([a], ctx);
        if (r) return fail(r);
        actions.push(a);
        break;
      }
      case "update": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        const merged: Record<string, unknown> = { ...actions[k] };
        for (const [key, v] of Object.entries(op.patch)) {
          if (key === "id") return fail([issue("INVALID_ACTION", ["patch", "id"], "Action ids cannot change")]);
          if (v === null) delete merged[key];
          else merged[key] = clone(v);
        }
        if ("duration" in op.patch && op.patch.duration !== null) delete merged.end;
        if ("end" in op.patch && op.patch.end !== null) delete merged.duration;
        if ("speech" in op.patch) delete merged.speechId;
        const p = CharacterActionSchema.safeParse(merged);
        if (!p.success) return fail(zodIssues(p.error, ["patch"]));
        const r = resolveSpeech([merged as CharacterAction], ctx);
        if (r) return fail(r);
        actions[k] = merged as CharacterAction;
        break;
      }
      case "replace": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        const a = { ...clone(op.action), id: op.id } as CharacterAction;
        const r = resolveSpeech([a], ctx);
        if (r) return fail(r);
        actions[k] = a;
        break;
      }
      case "remove": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        actions.splice(k, 1);
        break;
      }
      case "shift": {
        for (const a of actions) {
          if (op.ids ? !op.ids.includes(a.id!) : a.start < (op.after ?? 0)) continue;
          a.start = Math.round((a.start + op.by) * 1000) / 1000;
          if (a.end !== undefined) a.end = Math.round((a.end + op.by) * 1000) / 1000;
          if (a.start < 0) return fail([issue("INVALID_ACTION", ["by"], `Shifting moves "${a.id}" before 0 s`)]);
        }
        break;
      }
      case "clear":
        actions = op.actions ? actions.filter((a) => !op.actions!.includes(a.action)) : [];
        break;
    }
  }
  actions.sort((a, b) => a.start - b.start);
  return withCompile(doc, ctx, (d) => {
    d.characters[idx].actions = actions;
    return { actions };
  }, () => [instanceId]);
}

/** Recompiles every instance (e.g. after the scene duration/fps changed or a character was re-prepared). */
export function recompileCharacters(doc: SceneDoc, ctx: CharacterContext, ids?: string[]): OpResult<{ plans?: Record<string, Plan> }> {
  return withCompile(doc, ctx, () => ({}), ids ? () => ids : undefined);
}

/** Validates the prop list shape (used by tools before updateCharacter). */
export const PropsSchema = z.array(CharacterPropSchema);
