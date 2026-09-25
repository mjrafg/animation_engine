/**
 * 3D scene editing operations. Same contract as the 2D operations (src/api/operations.ts): pure,
 * transactional (applied to a copy, rejected if they introduce a validation error), returning
 * machine-readable issues. Timeline operations (keyframes, tracks, audio, duration) are shared
 * with 2D: applyTimelineOps / setAudio / setSceneProps work on 3D documents unchanged.
 */
import { CanvasSchema } from "../scene/schema.js";
import { issue, ownedIssue, transact, zodIssues, type OpResult, type SceneDoc } from "../api/operations.js";
import { Camera3DSchema, Light3DSchema, Object3DSchema, Render3DSchema, Scene3DSchema, World3DSchema } from "./schema.js";

const clone = <T>(v: T): T => structuredClone(v);

export interface CreateScene3DArgs {
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number; background?: string };
  duration?: number;
}

export function createScene3D(args: CreateScene3DArgs = {}): OpResult {
  const canvas = { width: 1280, height: 720, fps: 24, background: "#000000", ...args.canvas };
  const c = CanvasSchema.safeParse(canvas);
  if (!c.success) return { ok: false, errors: zodIssues(c.error, ["canvas"]) };
  const doc = {
    version: 1,
    kind: "3d",
    ...(args.name ? { name: args.name } : {}),
    canvas: c.data,
    duration: args.duration ?? c.data.fps * 5,
    lights: [],
    objects: [],
    animations: [],
    audio: [],
  };
  const p = Scene3DSchema.safeParse(doc);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, []) };
  // store the defaults explicitly so the document is self-describing
  return { ok: true, scene: JSON.parse(JSON.stringify(p.data)), warnings: [] };
}

const allIds = (d: SceneDoc): Set<string> => new Set([...(d.objects ?? []), ...(d.lights ?? [])].map((o: any) => o.id));

/**
 * Adds objects and/or lights in ONE validated step (a child or attachment may precede its target).
 * Either everything is added or nothing.
 */
export function addEntities3D(doc: SceneDoc, args: { objects?: unknown[]; lights?: unknown[] }): OpResult<{ added: string[] }> {
  const ids = allIds(doc);
  const check = (list: unknown[], schema: typeof Object3DSchema | typeof Light3DSchema, key: string) => {
    for (let i = 0; i < list.length; i++) {
      const p = schema.safeParse(list[i]);
      if (!p.success) return zodIssues(p.error, [key, i]);
      if (ids.has(p.data.id)) return [issue("DUPLICATE_LAYER_ID", [key, i, "id"], `"${p.data.id}" already exists in this scene`)];
      ids.add(p.data.id);
    }
    return null;
  };
  const objects = args.objects ?? [];
  const lights = args.lights ?? [];
  const bad = check(objects, Object3DSchema, "objects") ?? check(lights, Light3DSchema, "lights");
  if (bad) return { ok: false, errors: bad };
  return transact(doc, (d) => {
    d.objects = [...(d.objects ?? []), ...objects.map(clone)];
    d.lights = [...(d.lights ?? []), ...lights.map(clone)];
    return { added: [...objects, ...lights].map((o: any) => String(o.id)) };
  });
}

function locate(d: SceneDoc, id: string): { list: "objects" | "lights"; index: number } | null {
  for (const list of ["objects", "lights"] as const) {
    const index = (d[list] ?? []).findIndex((o: any) => o.id === id);
    if (index >= 0) return { list, index };
  }
  return null;
}

/**
 * Merges `patch` into an object or light. Nested vectors merge per axis ({position: {y: 2}} keeps
 * x and z). A `null` value deletes the key (resets it to its default; parent/attach/clip: detach).
 */
export function updateEntity3D(doc: SceneDoc, id: string, patch: Record<string, unknown>): OpResult<{ kind: "object" | "light" }> {
  const at = locate(doc, id);
  if (!at) return { ok: false, errors: [issue("MISSING_TARGET", ["id"], `No object or light "${id}"`)] };
  const owned = ownedIssue(doc, id);
  if (owned) return { ok: false, errors: [owned] };
  if ("id" in patch && patch.id !== id) {
    return { ok: false, errors: [issue("IMMUTABLE_ID", ["patch", "id"], "Ids cannot be changed; remove and re-add instead")] };
  }
  const schema = at.list === "objects" ? Object3DSchema : Light3DSchema;
  const merged: Record<string, any> = clone(doc[at.list][at.index]);
  const defaults = schema.safeParse(merged);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && merged[k] === undefined && defaults.success) merged[k] = clone((defaults.data as any)[k]);
    if (v === null) delete merged[k];
    else if (["position", "rotation", "scale", "size"].includes(k) && v && typeof v === "object" && merged[k]) merged[k] = { ...merged[k], ...v };
    else if (k === "morphs" && v && typeof v === "object") merged[k] = { ...merged[k], ...v };
    else merged[k] = v;
  }
  const p = schema.safeParse(merged);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["patch"]) };
  return transact(doc, (d) => {
    d[at.list][at.index] = merged;
    return { kind: at.list === "objects" ? "object" : "light" };
  });
}

/**
 * Removes an object or light and its animation tracks. Children (parent) and attachments pointing
 * at a removed object: "error" (default) refuses, "cascade" removes them too, "detach" keeps them
 * at the scene root.
 */
export function removeEntity3D(doc: SceneDoc, id: string, children: "error" | "cascade" | "detach" = "error"): OpResult<{ removed: string[] }> {
  const at = locate(doc, id);
  if (!at) return { ok: false, errors: [issue("MISSING_TARGET", ["id"], `No object or light "${id}"`)] };
  const ownedR = ownedIssue(doc, id);
  if (ownedR) return { ok: false, errors: [ownedR] };
  const dependsOn = (o: any, set: Set<string>) => (o.parent && set.has(o.parent)) || (o.attach && set.has(o.attach.object));
  const direct = (doc.objects ?? []).filter((o: any) => dependsOn(o, new Set([id]))).map((o: any) => o.id);
  if (direct.length && children === "error") {
    return { ok: false, errors: [issue("HAS_CHILDREN", ["id"], `"${id}" has children or attachments; pass children: "cascade" or "detach"`, { children: direct })] };
  }
  return transact(doc, (d) => {
    const removed = new Set([id]);
    if (children === "cascade") {
      let grew = true;
      while (grew) {
        grew = false;
        for (const o of d.objects ?? []) {
          if (!removed.has(o.id) && dependsOn(o, removed)) {
            removed.add(o.id);
            grew = true;
          }
        }
      }
    } else {
      for (const o of d.objects ?? []) {
        if (o.parent === id) delete o.parent;
        if (o.attach?.object === id) delete o.attach;
      }
    }
    d.objects = (d.objects ?? []).filter((o: any) => !removed.has(o.id));
    d.lights = (d.lights ?? []).filter((o: any) => !removed.has(o.id));
    d.animations = (d.animations ?? []).filter((a: any) => !removed.has(a.target));
    const la = d.camera?.lookAt;
    if (la && typeof la === "object" && "object" in la && removed.has(la.object)) delete d.camera.lookAt;
    return { removed: [...removed] };
  });
}

export interface Settings3DPatch {
  camera?: Record<string, unknown>;
  world?: Record<string, unknown>;
  render?: Record<string, unknown>;
  /** {scene: id} to draw a 2D scene over the 3D render, null to remove. */
  overlay?: { scene: string } | null;
}

/** Patches camera / world / render settings / overlay. Keys set to null reset to their default. */
export function setSettings3D(doc: SceneDoc, patch: Settings3DPatch): OpResult {
  const next: Record<string, any> = {};
  const merge = (cur: any, p: Record<string, unknown>) => {
    const out: Record<string, any> = { ...(cur ?? {}) };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete out[k];
      else if (["position", "rotation"].includes(k) && v && typeof v === "object" && out[k] && !("object" in (v as object))) out[k] = { ...out[k], ...v };
      else out[k] = v;
    }
    return out;
  };
  const schemas = { camera: Camera3DSchema, world: World3DSchema, render: Render3DSchema } as const;
  for (const k of ["camera", "world", "render"] as const) {
    if (!patch[k]) continue;
    const cur = schemas[k].safeParse(doc[k] ?? {});
    next[k] = merge(cur.success ? cur.data : doc[k], patch[k]!);
    const p = schemas[k].safeParse(next[k]);
    if (!p.success) return { ok: false, errors: zodIssues(p.error, [k]) };
  }
  return transact(doc, (d) => {
    Object.assign(d, next);
    if (patch.overlay === null) delete d.overlay;
    else if (patch.overlay) d.overlay = clone(patch.overlay);
  });
}
