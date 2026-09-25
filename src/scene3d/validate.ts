/**
 * 3D scene validation: schema + references (assets, clips, bones/sockets, morph targets, parents,
 * attachments, animation targets). Same issue format as the 2D validator, so the same error
 * mapping (EngineError codes) and client handling apply.
 */
import type { ValidationIssue, ValidationResult } from "../scene/validate.js";
import type { ModelInfo } from "./gltf.js";
import { RESERVED_3D_TARGETS, Scene3DSchema, propertyList3D, propertySpec3D, type Scene3D, type Target3DKind } from "./schema.js";

export interface AssetLookup3D {
  (assetId: string): { kind: string; model?: ModelInfo } | undefined;
}

export type Validation3DResult = Omit<ValidationResult, "scene"> & { scene?: Scene3D };

/** Resolves a bone given as a joint name or semantic socket name; null if unknown. */
export function resolveBone(model: ModelInfo | undefined, bone: string): string | null {
  if (!model) return null;
  if (model.joints.some((j) => j.name === bone)) return bone;
  return model.sockets[bone] ?? null;
}

export function validateScene3D(input: unknown, assets: AssetLookup3D): Validation3DResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, p: (string | number)[], message: string, details?: Record<string, unknown>) =>
    errors.push({ severity: "error", code, path: p, message, ...(details ? { details } : {}) });
  const warn = (code: string, p: (string | number)[], message: string) => warnings.push({ severity: "warning", code, path: p, message });

  const parsed = Scene3DSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const code =
        i.code === "unrecognized_keys" ? "UNKNOWN_PROPERTY" : i.code === "too_small" ? "VALUE_TOO_SMALL" : i.code === "too_big" ? "VALUE_TOO_BIG" : i.code === "invalid_type" ? "INVALID_TYPE" : "INVALID_VALUE";
      err(code, i.path.map((k) => (typeof k === "symbol" ? String(k) : k)), i.message);
    }
    return { ok: false, errors, warnings };
  }
  const s = parsed.data;

  // ids
  const kindOf = new Map<string, Target3DKind>();
  const objIndex = new Map<string, number>();
  const seen = (id: string, p: (string | number)[]) => {
    if ((RESERVED_3D_TARGETS as readonly string[]).includes(id)) err("RESERVED_LAYER_ID", p, `"${id}" is reserved`);
    else if (kindOf.has(id)) err("DUPLICATE_LAYER_ID", p, `Duplicate id "${id}" (object and light ids share one namespace)`);
  };
  s.objects.forEach((o, i) => {
    seen(o.id, ["objects", i, "id"]);
    kindOf.set(o.id, "object");
    objIndex.set(o.id, i);
  });
  s.lights.forEach((l, i) => {
    seen(l.id, ["lights", i, "id"]);
    kindOf.set(l.id, "light");
  });

  const modelOf = (objId: string): ModelInfo | undefined => {
    const o = s.objects[objIndex.get(objId) ?? -1];
    return o?.asset ? assets(o.asset)?.model : undefined;
  };

  // objects
  s.objects.forEach((o, i) => {
    const p = ["objects", i];
    if (o.asset && o.primitive) err("INVALID_VALUE", p, `Object "${o.id}" has both an asset and a primitive; use one`);
    let model: ModelInfo | undefined;
    if (o.asset) {
      const a = assets(o.asset);
      if (!a) err("MISSING_ASSET", [...p, "asset"], `Object "${o.id}" references unknown asset "${o.asset}"`);
      else if (a.kind !== "model" || !a.model) err("INVALID_ASSET", [...p, "asset"], `Asset "${o.asset}" is a ${a.kind}, not a 3D model (.glb/.gltf)`);
      else model = a.model;
    }
    if (o.clip) {
      if (!model) err("CLIP_NOT_FOUND", [...p, "clip"], `Object "${o.id}" has no model with animation clips`);
      else if (!model.clips.some((c) => c.name === o.clip)) {
        err("CLIP_NOT_FOUND", [...p, "clip"], `Model "${o.asset}" has no clip "${o.clip}"`, { available: model.clips.map((c) => c.name) });
      }
    }
    for (const m of Object.keys(o.morphs ?? {})) {
      if (!model?.morphTargets.includes(m)) err("MORPH_NOT_FOUND", [...p, "morphs", m], `Object "${o.id}" has no morph target "${m}"`, { available: model?.morphTargets ?? [] });
    }
    if (o.parent != null) {
      if (o.parent === o.id) err("PARENT_CYCLE", [...p, "parent"], `Object "${o.id}" is its own parent`);
      else if (kindOf.get(o.parent) !== "object") err("MISSING_PARENT", [...p, "parent"], `Object "${o.id}" references unknown parent "${o.parent}"`);
    }
    if (o.attach) {
      if (o.parent != null) err("INVALID_PARENT", [...p, "attach"], `Object "${o.id}" cannot have both parent and attach`);
      if (o.attach.object === o.id) err("INVALID_PARENT", [...p, "attach", "object"], `Object "${o.id}" cannot attach to itself`);
      else if (kindOf.get(o.attach.object) !== "object") err("MISSING_PARENT", [...p, "attach", "object"], `Attach target "${o.attach.object}" is not an object in this scene`);
      else {
        const tm = modelOf(o.attach.object);
        if (!tm?.rigged) err("BONE_NOT_FOUND", [...p, "attach", "object"], `Attach target "${o.attach.object}" is not a rigged model`);
        else if (!resolveBone(tm, o.attach.bone)) {
          err("BONE_NOT_FOUND", [...p, "attach", "bone"], `Model of "${o.attach.object}" has no bone or socket "${o.attach.bone}"`, {
            sockets: tm.sockets,
            joints: tm.joints.map((j) => j.name).slice(0, 80),
          });
        }
      }
    }
  });

  // parent/attach cycles
  const up = (id: string) => {
    const o = s.objects[objIndex.get(id) ?? -1];
    return o ? (o.parent ?? o.attach?.object ?? null) : null;
  };
  const reported = new Set<string>();
  for (const o of s.objects) {
    const chain: string[] = [];
    let cur: string | null = o.id;
    while (cur && objIndex.has(cur)) {
      if (chain.includes(cur)) {
        const cyc = chain.slice(chain.indexOf(cur));
        const key = [...cyc].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          err("PARENT_CYCLE", ["objects", objIndex.get(cur)!, "parent"], `Parent/attach cycle: ${[...cyc, cur].join(" -> ")}`, { cycle: cyc });
        }
        break;
      }
      chain.push(cur);
      cur = up(cur);
    }
  }

  // camera lookAt
  const la = s.camera.lookAt;
  if (la && "object" in la) {
    if (kindOf.get(la.object) !== "object") err("MISSING_TARGET", ["camera", "lookAt", "object"], `Camera lookAt target "${la.object}" is not an object`);
    else if (la.bone && !resolveBone(modelOf(la.object), la.bone)) err("BONE_NOT_FOUND", ["camera", "lookAt", "bone"], `No bone or socket "${la.bone}" on "${la.object}"`);
  }

  // animations
  const tracks = new Map<string, number>();
  s.animations.forEach((anim, ai) => {
    const base: (string | number)[] = ["animations", ai];
    const kind: Target3DKind | undefined = anim.target === "camera" ? "camera" : anim.target === "world" ? "world" : kindOf.get(anim.target);
    if (!kind) {
      err("MISSING_TARGET", [...base, "target"], `Animation target "${anim.target}" is not an object, light, "camera" or "world"`);
      return;
    }
    const spec = propertySpec3D(kind, anim.property);
    if (!spec) {
      err("UNSUPPORTED_PROPERTY", [...base, "property"], `Property "${anim.property}" cannot be animated on a ${kind}`, { supported: propertyList3D(kind) });
      return;
    }
    const model = kind === "object" ? modelOf(anim.target) : undefined;
    if (anim.property.startsWith("morph.") && !model?.morphTargets.includes(anim.property.slice(6))) {
      err("MORPH_NOT_FOUND", [...base, "property"], `"${anim.target}" has no morph target "${anim.property.slice(6)}"`, { available: model?.morphTargets ?? [] });
    }
    const key = `${anim.target}\u0000${anim.property}`;
    if (tracks.has(key)) err("DUPLICATE_TRACK", base, `"${anim.target}.${anim.property}" is animated by more than one track`);
    tracks.set(key, ai);
    const frames = new Set<number>();
    anim.keyframes.forEach((kf, ki) => {
      const kp = [...base, "keyframes", ki];
      if (frames.has(kf.frame)) err("DUPLICATE_KEYFRAME", [...kp, "frame"], `Two keyframes at frame ${kf.frame}`);
      frames.add(kf.frame);
      if (kf.frame >= s.duration) warn("KEYFRAME_AFTER_END", [...kp, "frame"], `Keyframe at frame ${kf.frame} is at/after the scene end (duration ${s.duration})`);
      const v = kf.value;
      if (spec.kind === "number") {
        if (typeof v !== "number") err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a number`);
        else if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max) || (spec.gt !== undefined && v <= spec.gt)) {
          err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" value ${v} is out of range`);
        }
      } else if (spec.kind === "boolean" && typeof v !== "boolean") err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a boolean`);
      else if (spec.kind === "string") {
        if (typeof v !== "string") err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a string`);
        else if (anim.property === "clip" && v !== "" && !model?.clips.some((c) => c.name === v)) {
          err("CLIP_NOT_FOUND", [...kp, "value"], `"${anim.target}" has no clip "${v}"`, { available: model?.clips.map((c) => c.name) ?? [] });
        } else if (anim.property === "color" && !/^#[0-9a-fA-F]{6}$/.test(v)) err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"color" needs #rrggbb`);
      }
      const interp = kf.interpolation ?? (spec.continuous ? "linear" : "step");
      if (!spec.continuous && interp !== "step") err("INVALID_INTERPOLATION", [...kp, "interpolation"], `"${anim.property}" is discrete and only supports "step" (got "${interp}")`);
      if (interp === "cubic-bezier" && !kf.bezier) err("MISSING_BEZIER", [...kp, "bezier"], `"cubic-bezier" interpolation requires bezier`);
    });
  });

  if (s.overlay && s.overlay.scene === undefined) err("INVALID_VALUE", ["overlay"], "overlay needs a scene id");

  return errors.length ? { ok: false, errors, warnings } : { ok: true, scene: s, errors, warnings };
}
