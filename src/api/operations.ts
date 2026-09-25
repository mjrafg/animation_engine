/**
 * Agent-facing scene editing operations.
 *
 * Every operation is a pure function: (scene document, args) -> result with a NEW document.
 * Operations are transactional: the edit is applied to a copy, the copy is validated, and the
 * edit is rejected (returning machine-readable errors) if it introduces a new validation error.
 * Pre-existing problems in the document do not block unrelated edits.
 */
import {
  AnimationSchema,
  AssetSchema,
  CAMERA_TARGET,
  CameraSchema,
  CanvasSchema,
  KeyframeSchema,
  LayerSchema,
} from "../scene/schema.js";
import { validateScene, type ValidationIssue } from "../scene/validate.js";
import type { z } from "zod";

// Documents are plain JSON; keep types loose on purpose (the validator is the source of truth).
export type SceneDoc = Record<string, any>;

export type OpResult<T = void> =
  | { ok: true; scene: SceneDoc; result?: T; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[] };

const clone = <T>(v: T): T => structuredClone(v);

const issue = (code: string, path: (string | number)[], message: string, details?: Record<string, unknown>): ValidationIssue => ({
  severity: "error",
  code,
  path,
  message,
  ...(details ? { details } : {}),
});

const key = (i: ValidationIssue) => `${i.code}|${JSON.stringify(i.path)}|${i.message}`;

/** Apply `mutate` to a copy and keep it only if no new validation errors appear. */
function transact<T>(doc: SceneDoc, mutate: (d: SceneDoc) => T): OpResult<T> {
  const before = new Set(validateScene(doc, { checkFiles: false }).errors.map(key));
  const next = clone(doc);
  const result = mutate(next);
  const after = validateScene(next, { checkFiles: false });
  const introduced = after.errors.filter((e) => !before.has(key(e)));
  if (introduced.length) return { ok: false, errors: introduced };
  return { ok: true, scene: next, result, warnings: after.warnings };
}

function zodIssues(err: z.ZodError, prefix: (string | number)[]): ValidationIssue[] {
  return err.issues.map((i) =>
    issue(i.code === "unrecognized_keys" ? "UNKNOWN_PROPERTY" : "INVALID_" + i.code.toUpperCase(), [...prefix, ...i.path.map(String)], i.message),
  );
}

function layerIdx(d: SceneDoc, id: string): number {
  return (d.layers ?? []).findIndex((l: any) => l.id === id);
}

// ------------------------------------------------------------------------------------------

export interface CreateSceneArgs {
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number; background?: string };
  duration?: number;
}

export function createScene(args: CreateSceneArgs = {}): OpResult {
  const canvas = { width: 1920, height: 1080, fps: 30, background: "#000000", ...args.canvas };
  const c = CanvasSchema.safeParse(canvas);
  if (!c.success) return { ok: false, errors: zodIssues(c.error, ["canvas"]) };
  const scene: SceneDoc = {
    version: 1,
    ...(args.name ? { name: args.name } : {}),
    canvas: c.data,
    duration: args.duration ?? canvas.fps! * 5,
    assets: {},
    camera: { x: 0, y: 0, scale: 1, rotation: 0 },
    layers: [],
    animations: [],
    audio: [],
  };
  const v = validateScene(scene, { checkFiles: false });
  return v.ok ? { ok: true, scene, warnings: v.warnings } : { ok: false, errors: v.errors };
}

export function setAsset(doc: SceneDoc, id: string, asset: unknown): OpResult {
  const p = AssetSchema.safeParse(asset);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["assets", id]) };
  return transact(doc, (d) => {
    d.assets = { ...(d.assets ?? {}), [id]: asset };
  });
}

export function removeAsset(doc: SceneDoc, id: string): OpResult {
  if (!doc.assets || !(id in doc.assets)) return { ok: false, errors: [issue("MISSING_ASSET", ["assets", id], `No asset "${id}"`)] };
  return transact(doc, (d) => {
    delete d.assets[id];
  });
}

export interface AddLayerArgs {
  layer: Record<string, unknown>;
  /** Insert position in the document (affects only z tie-breaking). Default: end. */
  index?: number;
}

export function addLayer(doc: SceneDoc, args: AddLayerArgs): OpResult {
  const p = LayerSchema.safeParse(args.layer);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["layer"]) };
  if (layerIdx(doc, p.data.id) >= 0) {
    return { ok: false, errors: [issue("DUPLICATE_LAYER_ID", ["layer", "id"], `Layer "${p.data.id}" already exists`)] };
  }
  return transact(doc, (d) => {
    d.layers = d.layers ?? [];
    const i = args.index === undefined ? d.layers.length : Math.max(0, Math.min(d.layers.length, args.index));
    d.layers.splice(i, 0, clone(args.layer));
  });
}

/** Shallow-merge `patch` into the layer. A `null` value deletes the key (resets to default). */
export function updateLayer(doc: SceneDoc, id: string, patch: Record<string, unknown>): OpResult {
  const i = layerIdx(doc, id);
  if (i < 0) return { ok: false, errors: [issue("MISSING_LAYER", ["id"], `No layer "${id}"`)] };
  if ("id" in patch && patch.id !== id) {
    return { ok: false, errors: [issue("IMMUTABLE_ID", ["patch", "id"], "Layer ids cannot be changed; remove and re-add instead")] };
  }
  return transact(doc, (d) => {
    const layer = d.layers[i];
    for (const [k, v] of Object.entries(patch)) {
      if (v === null && k !== "asset" && k !== "parent") delete layer[k];
      else layer[k] = v;
    }
  });
}

export interface RemoveLayerArgs {
  id: string;
  /**
   * What to do with children: "error" (default) refuses, "cascade" removes descendants too,
   * "reparent" moves them to the removed layer's parent (their local values are kept as-is).
   */
  children?: "error" | "cascade" | "reparent";
}

export function removeLayer(doc: SceneDoc, args: RemoveLayerArgs): OpResult<{ removed: string[] }> {
  const i = layerIdx(doc, args.id);
  if (i < 0) return { ok: false, errors: [issue("MISSING_LAYER", ["id"], `No layer "${args.id}"`)] };
  const mode = args.children ?? "error";
  const children = (doc.layers as any[]).filter((l) => l.parent === args.id).map((l) => l.id);
  if (children.length && mode === "error") {
    return {
      ok: false,
      errors: [issue("HAS_CHILDREN", ["id"], `Layer "${args.id}" has children; pass children: "cascade" or "reparent"`, { children })],
    };
  }
  return transact(doc, (d) => {
    const removed = new Set<string>([args.id]);
    if (mode === "cascade") {
      let grew = true;
      while (grew) {
        grew = false;
        for (const l of d.layers) {
          if (l.parent && removed.has(l.parent) && !removed.has(l.id)) {
            removed.add(l.id);
            grew = true;
          }
        }
      }
    } else if (mode === "reparent") {
      const newParent = d.layers[i].parent ?? null;
      for (const l of d.layers) {
        if (l.parent === args.id) {
          if (newParent) l.parent = newParent;
          else delete l.parent;
          delete l.parentPoint;
        }
      }
    }
    d.layers = d.layers.filter((l: any) => !removed.has(l.id));
    d.animations = (d.animations ?? []).filter((a: any) => !removed.has(a.target));
    for (const l of d.layers) if (l.mask?.type === "layer" && removed.has(l.mask.layer)) delete l.mask;
    return { removed: [...removed] };
  });
}

export interface SetParentArgs {
  id: string;
  parent: string | null;
  parentPoint?: string | null;
}

export function setParent(doc: SceneDoc, args: SetParentArgs): OpResult {
  const i = layerIdx(doc, args.id);
  if (i < 0) return { ok: false, errors: [issue("MISSING_LAYER", ["id"], `No layer "${args.id}"`)] };
  return transact(doc, (d) => {
    const l = d.layers[i];
    if (args.parent === null) {
      delete l.parent;
      delete l.parentPoint;
    } else {
      l.parent = args.parent;
      if (args.parentPoint) l.parentPoint = args.parentPoint;
      else if (args.parentPoint === null) delete l.parentPoint;
    }
  });
}

export function setCamera(doc: SceneDoc, patch: Record<string, unknown>): OpResult {
  const cam = { ...(doc.camera ?? {}), ...patch };
  const p = CameraSchema.safeParse(cam);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["camera"]) };
  return transact(doc, (d) => {
    d.camera = cam;
  });
}

export function setSceneProps(doc: SceneDoc, patch: { duration?: number; canvas?: Record<string, unknown>; name?: string }): OpResult {
  return transact(doc, (d) => {
    if (patch.duration !== undefined) d.duration = patch.duration;
    if (patch.name !== undefined) d.name = patch.name;
    if (patch.canvas) d.canvas = { ...d.canvas, ...patch.canvas };
  });
}

// ------------------------------------------------------------------------------------------
// Keyframes. A track is identified by (target, property); target is a layer id or "camera".

export interface KeyframeArgs {
  target: string;
  property: string;
  keyframe: Record<string, unknown>;
}

function findTrack(d: SceneDoc, target: string, property: string): number {
  return (d.animations ?? []).findIndex((a: any) => a.target === target && a.property === property);
}

/** Adds a keyframe (creating the track if needed). Replaces an existing keyframe at the same frame. */
export function addKeyframe(doc: SceneDoc, args: KeyframeArgs): OpResult {
  const p = KeyframeSchema.safeParse(args.keyframe);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["keyframe"]) };
  if (args.target !== CAMERA_TARGET && layerIdx(doc, args.target) < 0) {
    return { ok: false, errors: [issue("MISSING_TARGET", ["target"], `No layer "${args.target}"`)] };
  }
  return transact(doc, (d) => {
    d.animations = d.animations ?? [];
    let t = findTrack(d, args.target, args.property);
    if (t < 0) {
      d.animations.push({ target: args.target, property: args.property, keyframes: [] });
      t = d.animations.length - 1;
    }
    const kfs = d.animations[t].keyframes.filter((k: any) => k.frame !== p.data.frame);
    kfs.push(clone(args.keyframe));
    kfs.sort((a: any, b: any) => a.frame - b.frame);
    d.animations[t].keyframes = kfs;
  });
}

export interface UpdateKeyframeArgs {
  target: string;
  property: string;
  frame: number;
  patch: Record<string, unknown>;
}

export function updateKeyframe(doc: SceneDoc, args: UpdateKeyframeArgs): OpResult {
  const t = findTrack(doc, args.target, args.property);
  if (t < 0) return { ok: false, errors: [issue("MISSING_TRACK", ["target"], `No track ${args.target}.${args.property}`)] };
  const k = doc.animations[t].keyframes.findIndex((kf: any) => kf.frame === args.frame);
  if (k < 0) return { ok: false, errors: [issue("MISSING_KEYFRAME", ["frame"], `No keyframe at frame ${args.frame}`)] };
  const merged = { ...doc.animations[t].keyframes[k], ...args.patch };
  const p = KeyframeSchema.safeParse(merged);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["patch"]) };
  return transact(doc, (d) => {
    const kfs = d.animations[t].keyframes;
    kfs[k] = merged;
    kfs.sort((a: any, b: any) => a.frame - b.frame);
  });
}

export function removeKeyframe(doc: SceneDoc, args: { target: string; property: string; frame: number }): OpResult {
  const t = findTrack(doc, args.target, args.property);
  if (t < 0) return { ok: false, errors: [issue("MISSING_TRACK", ["target"], `No track ${args.target}.${args.property}`)] };
  const kfs = doc.animations[t].keyframes as any[];
  if (!kfs.some((k) => k.frame === args.frame)) {
    return { ok: false, errors: [issue("MISSING_KEYFRAME", ["frame"], `No keyframe at frame ${args.frame}`)] };
  }
  return transact(doc, (d) => {
    const rest = d.animations[t].keyframes.filter((k: any) => k.frame !== args.frame);
    if (rest.length) d.animations[t].keyframes = rest;
    else d.animations.splice(t, 1); // empty track removed: property falls back to its static value
  });
}

/** Replace (or create) a whole track at once. */
export function setTrack(doc: SceneDoc, track: unknown): OpResult {
  const p = AnimationSchema.safeParse(track);
  if (!p.success) return { ok: false, errors: zodIssues(p.error, ["track"]) };
  return transact(doc, (d) => {
    d.animations = d.animations ?? [];
    const t = findTrack(d, p.data.target, p.data.property);
    if (t >= 0) d.animations[t] = clone(track);
    else d.animations.push(clone(track));
  });
}
