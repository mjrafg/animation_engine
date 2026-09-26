/**
 * Character operations on scene documents (2D and 3D). Same contract as every other scene
 * operation: pure, transactional, machine-readable issues. After each change the affected
 * instances are recompiled: everything they previously generated (layers/objects with
 * meta.character = id, tracks and audio with owner = id) is replaced by the new compilation.
 * Hand-authored content is never touched.
 */
import { issue, is3D, transact, zodIssues, type OpResult, type SceneDoc } from "../api/operations.js";
import type { ValidationIssue } from "../scene/validate.js";
import { compile2D, compile3D, type CompileExtras, type CompiledCharacter } from "./compile.js";
import type { InteractionDefinition } from "./interaction-defs.js";
import { interactionIdOf, interactionList, planScene, transferCopies } from "./interactions.js";
import type { ModelInfo } from "../scene3d/gltf.js";
import { characterActions, planCharacter, type Plan } from "./plan.js";
import {
  CharacterActionSchema,
  CharacterInstanceSchema,
  CharacterPropSchema,
  InteractionInstanceSchema,
  type InteractionInstance,
  type CharacterAction,
  type CharacterDefinition,
  type CharacterInstance,
  type SpeechTiming,
} from "./schema.js";
import { z } from "zod";
import { EngineError } from "../errors.js";

export interface CharacterContext {
  /** Prepared character definition (asset names already mapped to workspace asset ids). */
  definition(id: string): { def: CharacterDefinition; sha: string; continuity?: { continuous: boolean; gaps?: string[]; rigidJoints?: string[] } } | undefined;
  speech?(id: string): SpeechTiming | undefined;
  /** Workspace-relative file of an audio asset (2D/3D scene audio entries use files). */
  audioSrc?(assetId: string): string | undefined;
  /** Interaction definition (built-in or workspace custom). */
  interaction?(id: string): { def: InteractionDefinition; sha: string; builtin: boolean } | undefined;
  /** 3D: model facts of a model asset (joints, rest positions, bounds). */
  model?(assetId: string): ModelInfo | undefined;
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

/** Recompiles one instance inside `d` (mutates). Returns issues on failure. `pre`: a plan made by the scene planner (interactions). */
function compileInstance(
  d: SceneDoc,
  index: number,
  ctx: CharacterContext,
  pre?: { plan: Plan; extras: CompileExtras },
): { errors: ValidationIssue[]; warnings: ValidationIssue[]; plan?: Plan; compiled?: CompiledCharacter } {
  const inst = d.characters[index] as CharacterInstance;
  const p: (string | number)[] = ["characters", index];
  const entry = ctx.definition(inst.character);
  if (!entry) return { errors: [issue("CHARACTER_NOT_FOUND", [...p, "character"], `No prepared character "${inst.character}" in this workspace (character_import it first)`)], warnings: [] };
  const { def, sha } = entry;
  const kind = is3D(d) ? "3d" : "2d";
  if (def.kind !== kind) {
    return { errors: [issue("INVALID_ACTION", [...p, "character"], `"${inst.character}" is a ${def.kind.toUpperCase()} character; this is a ${kind.toUpperCase()} scene`)], warnings: [] };
  }
  const r = pre ? { ok: true, plan: pre.plan, errors: [], warnings: [] } : planCharacter(inst, def, { fps: d.canvas.fps, frames: d.duration, speech: ctx.speech?.bind(ctx) }, p);
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
      ? compile2D(plan, def, inst, { assetId: (name) => def.assets[name] ?? name }, pre?.extras)
      : compile3D(plan, def, inst, { modelAsset: def.model, idleClip: characterActions(def).idle?.clip ?? null }, pre?.extras);
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
  return { errors, warnings: r.warnings, plan, compiled };
}

/**
 * Recompiles characters inside `d`. Without interactions each instance is independent (`ids` or
 * all). With interactions the actors are coupled (positions, facing, contact targets, objects), so
 * the whole scene is planned together and every instance is recompiled.
 */
function compileCharacters(d: SceneDoc, ctx: CharacterContext, ids?: string[]): { errors: ValidationIssue[]; warnings: ValidationIssue[]; plans: Record<string, Plan> } {
  const plans: Record<string, Plan> = {};
  let warnings: ValidationIssue[] = [];
  if (!interactionList(d).length) {
    if (d.interactions) delete d.interactions;
    for (const id of ids ?? instances(d).map((x) => x.id)) {
      const idx = instances(d).findIndex((x) => x.id === id);
      if (idx < 0) continue;
      const c = compileInstance(d, idx, ctx);
      if (c.errors.length) return { errors: c.errors, warnings, plans };
      warnings = [...warnings, ...c.warnings];
      if (c.plan) plans[id] = c.plan;
    }
    return { errors: [], warnings, plans };
  }
  const sp = planScene(d, ctx);
  if (!sp.ok) return { errors: sp.errors, warnings: sp.warnings, plans };
  warnings = [...sp.warnings];
  const compiled: Record<string, CompiledCharacter> = {};
  for (const [idx, inst] of instances(d).entries()) {
    const c = compileInstance(d, idx, ctx, { plan: sp.plans[inst.id], extras: { reaches: sp.reaches[inst.id], hideProps: sp.hideProps[inst.id] } });
    if (c.errors.length) return { errors: c.errors, warnings, plans };
    warnings = [...warnings, ...c.warnings];
    plans[inst.id] = c.plan!;
    compiled[inst.id] = c.compiled!;
  }
  const copies = transferCopies(d, sp, compiled);
  warnings = [...warnings, ...copies.warnings];
  for (const it of copies.items) {
    if (is3D(d)) d.objects = [...(d.objects ?? []), it.entity];
    else d.layers = [...(d.layers ?? []), it.entity];
    d.animations = [...(d.animations ?? []), it.track];
  }
  for (const ip of sp.interactions) d.interactions[ip.index].definitionSha = ip.sha;
  return { errors: [], warnings, plans };
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
    const c = compileCharacters(d, ctx, ids ? ids() : undefined);
    if (c.errors.length) {
      failure = c.errors;
      return undefined as any;
    }
    warnings = [...warnings, ...c.warnings];
    return { ...(out as object), plans: c.plans } as any;
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
  const r = withCompile(doc, ctx, (d) => {
    d.characters = [...instances(d), inst];
    return { id: inst.id };
  }, () => [inst.id]);
  const cont = ctx.definition(inst.character)?.continuity;
  if (r.ok && cont && !cont.continuous) {
    r.warnings.push({
      severity: "warning",
      code: "CHARACTER_NOT_CONTINUOUS",
      path: ["character", "character"],
      message: `Character "${inst.character}" is not production-ready: joints ${[...(cont.gaps ?? cont.rigidJoints ?? [])].join(", ")} can show visible gaps when they bend (see character_inspect continuity)`,
    });
  }
  return r;
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

/**
 * Removes a character instance. If interactions involve it the call fails with
 * CHARACTER_IN_INTERACTION unless `removeInteractions` is set: then those interactions are removed
 * too and the remaining characters are recompiled (objects they received from it disappear).
 */
export function removeCharacter(doc: SceneDoc, id: string, opts: { removeInteractions?: boolean } = {}, ctx?: CharacterContext): OpResult<{ removed: string; removedInteractions?: string[] }> {
  const idx = instances(doc).findIndex((c) => c.id === id);
  if (idx < 0) return { ok: false, errors: [issue("CHARACTER_NOT_FOUND", ["id"], `No character instance "${id}" in this scene`, { instances: instances(doc).map((c) => c.id) })] };
  const deps = interactionList(doc)
    .map((ix, k) => ({ id: interactionIdOf(ix, k), actors: ix.actors }))
    .filter((x) => x.actors.includes(id));
  if (deps.length && !opts.removeInteractions) {
    return {
      ok: false,
      errors: [issue("CHARACTER_IN_INTERACTION", ["id"], `"${id}" takes part in interaction(s) ${deps.map((x) => x.id).join(", ")}; remove them first or pass removeInteractions: true`, { interactions: deps.map((x) => x.id) })],
    };
  }
  if (interactionList(doc).length) {
    if (!ctx) return { ok: false, errors: [issue("INVALID_ARGUMENT", ["id"], "Removing a character from a scene with interactions needs the character context")] };
    const gone = new Set(deps.map((x) => x.id));
    return withCompile(doc, ctx, (d) => {
      d.interactions = interactionList(d).filter((ix, k) => !gone.has(interactionIdOf(ix, k)));
      removeGenerated(d, id);
      d.characters = instances(d).filter((c) => c.id !== id);
      if (!d.characters.length) delete d.characters;
      detachFrom(d, id);
      return { removed: id, ...(deps.length ? { removedInteractions: [...gone] } : {}) };
    });
  }
  return transact(doc, (d) => {
    removeGenerated(d, id);
    d.characters = instances(d).filter((c) => c.id !== id);
    if (!d.characters.length) delete d.characters;
    detachFrom(d, id);
    return { removed: id };
  });
}

/** Hand-made layers/objects attached to a removed character's parts lose that parent. */
function detachFrom(d: SceneDoc, id: string) {
  const gone = (x: string | undefined | null) => !!x && (x === id || x.startsWith(id + "."));
  for (const l of is3D(d) ? d.objects ?? [] : d.layers ?? []) {
    if (gone(l.parent)) delete l.parent, delete l.parentPoint;
    if (l.attach && gone(l.attach.object)) delete l.attach;
  }
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

// ---- interactions --------------------------------------------------------------------------------

const InteractionFields = InteractionInstanceSchema.omit({ id: true, definitionSha: true });

export const InteractionOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add"), interaction: InteractionInstanceSchema.omit({ definitionSha: true }) }).strict(),
  z
    .object({
      type: z.literal("update"),
      id: z.string(),
      patch: z.record(z.string(), z.unknown()).describe("Fields to change: start, duration, actors, params, interaction; null removes duration/params."),
    })
    .strict(),
  z.object({ type: z.literal("replace"), id: z.string(), interaction: InteractionFields }).strict(),
  z.object({ type: z.literal("remove"), id: z.string() }).strict(),
  z.object({ type: z.literal("shift"), by: z.number(), after: z.number().min(0).optional().describe("Only interactions starting at/after this second (default all)."), ids: z.array(z.string()).optional() }).strict(),
  z.object({ type: z.literal("clear"), interactions: z.array(z.string()).optional().describe("Only interactions of these definitions (e.g. ['hug']); default all.") }).strict(),
]);
export type InteractionOp = z.infer<typeof InteractionOpSchema>;

/**
 * Applies interaction operations atomically (all or nothing) and recompiles every character of the
 * scene. A failing operation names operations[i]; planning problems (conflicts with the actors' own
 * actions, incompatible characters, objects not held) name the interaction.
 */
export function applyInteractionOps(doc: SceneDoc, ops: unknown[], ctx: CharacterContext): OpResult<{ interactions: InteractionInstance[]; plans?: Record<string, Plan> }> {
  let list: InteractionInstance[] = clone(interactionList(doc)).map((ix, k) => ({ ...ix, id: interactionIdOf(ix, k) }));
  const nextId = () => `ix${Math.max(0, ...list.map((x) => Number(/^ix(\d+)$/.exec(x.id ?? "")?.[1] ?? 0))) + 1}`;
  for (let i = 0; i < ops.length; i++) {
    const fail = (errors: ValidationIssue[]) => ({ ok: false as const, errors: errors.map((e) => ({ ...e, path: ["operations", i, ...e.path], details: { ...e.details, opIndex: i } })) });
    const parsed = InteractionOpSchema.safeParse(ops[i]);
    if (!parsed.success) return fail(zodIssues(parsed.error, []));
    const op = parsed.data;
    const find = (id: string) => list.findIndex((x) => x.id === id);
    const notFound = (id: string) => fail([issue("INTERACTION_NOT_FOUND", ["id"], `No interaction "${id}" in this scene`, { interactions: list.map((x) => `${x.id}:${x.interaction}`) })]);
    switch (op.type) {
      case "add": {
        if (op.interaction.id && find(op.interaction.id) >= 0) return fail([issue("INTERACTION_INVALID", ["interaction", "id"], `Interaction id "${op.interaction.id}" already exists`)]);
        list.push({ ...clone(op.interaction), id: op.interaction.id ?? nextId() });
        break;
      }
      case "update": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        const merged: Record<string, unknown> = { ...list[k] };
        for (const [key, v] of Object.entries(op.patch)) {
          if (key === "id" || key === "definitionSha") return fail([issue("INTERACTION_INVALID", ["patch", key], `"${key}" cannot be changed`)]);
          if (v === null) delete merged[key];
          else if (key === "params" && typeof v === "object") merged.params = { ...(merged.params as object), ...clone(v as object) };
          else merged[key] = clone(v);
        }
        const p = InteractionInstanceSchema.safeParse(merged);
        if (!p.success) return fail(zodIssues(p.error, ["patch"]));
        list[k] = merged as InteractionInstance;
        break;
      }
      case "replace": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        list[k] = { ...clone(op.interaction), id: op.id };
        break;
      }
      case "remove": {
        const k = find(op.id);
        if (k < 0) return notFound(op.id);
        list.splice(k, 1);
        break;
      }
      case "shift": {
        for (const x of list) {
          if (op.ids ? !op.ids.includes(x.id!) : x.start < (op.after ?? 0)) continue;
          x.start = Math.round((x.start + op.by) * 1000) / 1000;
          if (x.start < 0) return fail([issue("INTERACTION_INVALID", ["by"], `Shifting moves "${x.id}" before 0 s`)]);
        }
        break;
      }
      case "clear":
        list = op.interactions ? list.filter((x) => !op.interactions!.includes(x.interaction)) : [];
        break;
    }
  }
  list.sort((a, b) => a.start - b.start);
  for (const x of list) delete x.definitionSha;
  return withCompile(doc, ctx, (d) => {
    if (list.length) d.interactions = list;
    else delete d.interactions;
    return { interactions: list };
  });
}

/** Recompiles every instance (e.g. after the scene duration/fps changed or a character was re-prepared). */
export function recompileCharacters(doc: SceneDoc, ctx: CharacterContext, ids?: string[]): OpResult<{ plans?: Record<string, Plan> }> {
  return withCompile(doc, ctx, () => ({}), ids ? () => ids : undefined);
}

/** Validates the prop list shape (used by tools before updateCharacter). */
export const PropsSchema = z.array(CharacterPropSchema);

// ---- inspection ---------------------------------------------------------------------------------

/**
 * The resolved schedule of each character instance (from its stored actions): per action the
 * channel, seconds and frames, derived values (walk path and speed, speech source), what the
 * runtime generated for it, and whether the prepared definition changed since compilation.
 */
export function characterTimeline(doc: SceneDoc, ctx: CharacterContext, only?: string) {
  const list = instances(doc).filter((c) => !only || c.id === only);
  if (only && !list.length) {
    throw new EngineError("CHARACTER_NOT_FOUND", `No character instance "${only}" in this scene`, { instances: instances(doc).map((c) => c.id) });
  }
  const sp = interactionList(doc).length ? planScene(doc, ctx) : null;
  return list.map((inst) => {
    const entry = ctx.definition(inst.character);
    const generatedTracks = (doc.animations ?? []).filter((a: any) => a.owner === inst.id);
    const generated = {
      [is3D(doc) ? "objects" : "layers"]: (is3D(doc) ? doc.objects ?? [] : doc.layers ?? []).filter((x: any) => x.meta?.character === inst.id).map((x: any) => x.id),
      tracks: generatedTracks.length,
      keyframes: generatedTracks.reduce((s: number, a: any) => s + a.keyframes.length, 0),
      audio: (doc.audio ?? []).filter((a: any) => a.owner === inst.id).length,
    };
    if (!entry) return { id: inst.id, character: inst.character, error: "CHARACTER_NOT_FOUND", actions: inst.actions ?? [], generated };
    const r: { plan?: Plan; errors: ValidationIssue[]; warnings: ValidationIssue[] } = sp
      ? { plan: sp.plans[inst.id], errors: sp.errors, warnings: sp.warnings }
      : planCharacter(inst, entry.def, { fps: doc.canvas.fps, frames: doc.duration, speech: ctx.speech?.bind(ctx) });
    const resolved = r.plan?.resolved ?? {};
    const injected = Object.entries(resolved)
      .filter(([, v]) => v.source)
      .map(([id, v]) => ({ id, ...v }) as Record<string, unknown>)
      .sort((a, b) => (a.startFrame as number) - (b.startFrame as number));
    return {
      id: inst.id,
      character: inst.character,
      kind: entry.def.kind,
      stale: inst.definitionSha !== undefined && inst.definitionSha !== entry.sha,
      placement: entry.def.kind === "2d" ? { x: inst.x ?? 0, y: inst.y ?? 0, scale: inst.scale ?? 1, facing: inst.facing ?? entry.def.defaults.facing ?? "right", z: inst.z ?? 10 } : { position: inst.position ?? { x: 0, y: 0, z: 0 }, scale: inst.scale ?? 1, facing: inst.facing ?? entry.def.defaults.facing ?? "camera" },
      props: inst.props ?? [],
      actions: (inst.actions ?? []).map((a) => {
        const { speech, ...rest } = a;
        return { ...rest, ...(speech && typeof speech === "object" ? { speech: `inline (${speech.visemes ? "visemes" : speech.characters ? "characters" : speech.words ? "words" : "no timing"})` } : speech ? { speech } : {}), resolved: resolved[a.id ?? ""] ?? null };
      }),
      blinks: r.plan
        ? r.plan.blinks.map((b) => ({ at: +(b.f0 / doc.canvas.fps).toFixed(2), source: b.actionId ? `action ${b.actionId}` : "autoBlink" })).sort((x, y) => x.at - y.at)
        : [],
      interactionActions: injected,
      note: "actions are listed in start order; blinks: autoBlink keeps >= 1 s away from scheduled blinks" + (injected.length ? "; interactionActions are scheduled by interactions (interaction_inspect)" : ""),
      generated,
      issues: [...r.errors, ...r.warnings].map(({ severity, code, message }) => ({ severity, code, message })),
    };
  });
}
