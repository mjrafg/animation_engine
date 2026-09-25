/**
 * Scene validation: structural (Zod) + semantic (references, cycles, keyframes, files).
 *
 * The validator never throws on bad input. It returns machine-readable issues that an agent can
 * act on: a stable `code`, a JSON `path` into the scene document, and a human `message`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CAMERA_PROPERTIES,
  CAMERA_TARGET,
  COLOR_RE,
  LAYER_PROPERTIES,
  SceneSchema,
  type PropertySpec,
  type Scene,
} from "./schema.js";

export type IssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: IssueSeverity;
  code: string;
  /** JSON path into the scene document, e.g. ["layers", 3, "parent"]. */
  path: (string | number)[];
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  ok: boolean;
  /** Parsed scene with defaults applied; present only when there are no errors. */
  scene?: Scene;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidateOptions {
  /** Directory that relative asset/audio paths resolve against. Required for file checks. */
  baseDir?: string;
  /** Check that asset and audio files exist on disk (default true when baseDir is given). */
  checkFiles?: boolean;
}

function zodCode(code: string): string {
  switch (code) {
    case "unrecognized_keys":
      return "UNKNOWN_PROPERTY";
    case "invalid_type":
      return "INVALID_TYPE";
    case "too_small":
      return "VALUE_TOO_SMALL";
    case "too_big":
      return "VALUE_TOO_BIG";
    case "invalid_format":
      return "INVALID_FORMAT";
    case "invalid_value":
      return "INVALID_VALUE";
    case "invalid_union":
      return "INVALID_UNION";
    case "not_multiple_of":
      return "INVALID_VALUE";
    default:
      return "SCHEMA_" + code.toUpperCase();
  }
}

export function resolveScenePath(baseDir: string | undefined, p: string): string {
  if (path.isAbsolute(p) || !baseDir) return p;
  return path.join(baseDir, p);
}

export function validateScene(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (code: string, p: (string | number)[], message: string, details?: Record<string, unknown>) =>
    errors.push({ severity: "error", code, path: p, message, ...(details ? { details } : {}) });
  const warn = (code: string, p: (string | number)[], message: string, details?: Record<string, unknown>) =>
    warnings.push({ severity: "warning", code, path: p, message, ...(details ? { details } : {}) });

  const parsed = SceneSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const details: Record<string, unknown> = {};
      const anyIssue = issue as unknown as Record<string, unknown>;
      if (anyIssue.keys) details.keys = anyIssue.keys;
      if (anyIssue.expected !== undefined) details.expected = anyIssue.expected;
      if (anyIssue.minimum !== undefined) details.minimum = anyIssue.minimum;
      if (anyIssue.maximum !== undefined) details.maximum = anyIssue.maximum;
      err(
        zodCode(issue.code),
        issue.path.map((k) => (typeof k === "symbol" ? String(k) : k)),
        issue.message,
        Object.keys(details).length ? details : undefined,
      );
    }
    return { ok: false, errors, warnings };
  }

  const scene = parsed.data;
  const checkFiles = options.checkFiles ?? options.baseDir !== undefined;

  // --- assets -----------------------------------------------------------------------------
  if (checkFiles) {
    for (const [id, asset] of Object.entries(scene.assets)) {
      const file = resolveScenePath(options.baseDir, asset.src);
      if (!fs.existsSync(file)) {
        err("MISSING_ASSET_FILE", ["assets", id, "src"], `Asset "${id}" file not found: ${asset.src}`, { file });
      }
    }
  }

  // --- layers -----------------------------------------------------------------------------
  const layerIndex = new Map<string, number>();
  scene.layers.forEach((layer, i) => {
    if (layer.id === CAMERA_TARGET) {
      err("RESERVED_LAYER_ID", ["layers", i, "id"], `"${CAMERA_TARGET}" is reserved for the camera`);
    }
    if (layerIndex.has(layer.id)) {
      err("DUPLICATE_LAYER_ID", ["layers", i, "id"], `Duplicate layer id "${layer.id}"`, {
        firstIndex: layerIndex.get(layer.id),
      });
    } else {
      layerIndex.set(layer.id, i);
    }
  });

  scene.layers.forEach((layer, i) => {
    if (layer.asset != null && !(layer.asset in scene.assets)) {
      err("MISSING_ASSET", ["layers", i, "asset"], `Layer "${layer.id}" references unknown asset "${layer.asset}"`, {
        availableAssets: Object.keys(scene.assets),
      });
    }
    if (layer.asset != null && layer.fill !== undefined) {
      warn("FILL_IGNORED", ["layers", i, "fill"], `Layer "${layer.id}" has an asset; fill is ignored`);
    }
    if (layer.parent != null) {
      if (layer.parent === layer.id) {
        err("PARENT_CYCLE", ["layers", i, "parent"], `Layer "${layer.id}" is its own parent`);
      } else if (!layerIndex.has(layer.parent)) {
        err("MISSING_PARENT", ["layers", i, "parent"], `Layer "${layer.id}" references unknown parent "${layer.parent}"`);
      }
    }
    if (layer.parentPoint !== undefined) {
      if (layer.parent == null) {
        err("PARENT_POINT_WITHOUT_PARENT", ["layers", i, "parentPoint"], `Layer "${layer.id}" sets parentPoint but has no parent`);
      } else if (layerIndex.has(layer.parent)) {
        const parent = scene.layers[layerIndex.get(layer.parent)!];
        const points = {
          ...(parent.asset ? scene.assets[parent.asset]?.attachmentPoints : undefined),
          ...parent.attachmentPoints,
        };
        if (!(layer.parentPoint in points)) {
          err(
            "MISSING_ATTACHMENT_POINT",
            ["layers", i, "parentPoint"],
            `Parent "${parent.id}" has no attachment point "${layer.parentPoint}"`,
            { available: Object.keys(points) },
          );
        }
      }
    }
    if (layer.mask) {
      if (layer.mask.type === "layer") {
        if (layer.mask.layer === layer.id) {
          err("INVALID_MASK", ["layers", i, "mask", "layer"], `Layer "${layer.id}" cannot mask itself`);
        } else if (!layerIndex.has(layer.mask.layer)) {
          err("INVALID_MASK", ["layers", i, "mask", "layer"], `Mask layer "${layer.mask.layer}" does not exist`);
        } else {
          const m = scene.layers[layerIndex.get(layer.mask.layer)!];
          if (m.mask) warn("NESTED_MASK_IGNORED", ["layers", i, "mask"], `Mask layer "${m.id}" has its own mask, which is ignored when it is used as a mask`);
          if (m.asset == null && m.fill === undefined) {
            warn("EMPTY_MASK", ["layers", i, "mask"], `Mask layer "${m.id}" has no asset or fill, so it masks everything out`);
          }
        }
      } else if (layer.mask.width === 0 || layer.mask.height === 0) {
        warn("EMPTY_MASK", ["layers", i, "mask"], `Rect mask of layer "${layer.id}" has zero area`);
      }
    }
  });

  // Parent cycles (only meaningful once every parent exists).
  const reportedCycle = new Set<string>();
  for (const layer of scene.layers) {
    const seen: string[] = [];
    let cur: string | null | undefined = layer.id;
    while (cur != null && layerIndex.has(cur)) {
      if (seen.includes(cur)) {
        const cycle = seen.slice(seen.indexOf(cur));
        const key = [...cycle].sort().join(",");
        if (!reportedCycle.has(key)) {
          reportedCycle.add(key);
          err("PARENT_CYCLE", ["layers", layerIndex.get(cur)!, "parent"], `Parent cycle: ${[...cycle, cur].join(" -> ")}`, {
            cycle,
          });
        }
        break;
      }
      seen.push(cur);
      cur = scene.layers[layerIndex.get(cur)!].parent;
    }
  }

  // --- animations -------------------------------------------------------------------------
  const trackKeys = new Map<string, number>();
  scene.animations.forEach((anim, ai) => {
    const base: (string | number)[] = ["animations", ai];
    const isCamera = anim.target === CAMERA_TARGET;
    if (!isCamera && !layerIndex.has(anim.target)) {
      err("MISSING_TARGET", [...base, "target"], `Animation target "${anim.target}" is not a layer id or "camera"`);
      return;
    }
    const table = isCamera ? CAMERA_PROPERTIES : LAYER_PROPERTIES;
    const spec: PropertySpec | undefined = table[anim.property];
    if (!spec) {
      err("UNSUPPORTED_PROPERTY", [...base, "property"], `Property "${anim.property}" cannot be animated on ${isCamera ? "the camera" : "a layer"}`, {
        supported: Object.keys(table),
      });
      return;
    }
    const key = `${anim.target}\u0000${anim.property}`;
    if (trackKeys.has(key)) {
      err("DUPLICATE_TRACK", base, `"${anim.target}.${anim.property}" is animated by more than one track`, {
        otherIndex: trackKeys.get(key),
      });
    } else {
      trackKeys.set(key, ai);
    }

    const frames = new Map<number, number>();
    anim.keyframes.forEach((kf, ki) => {
      const kp = [...base, "keyframes", ki];
      if (frames.has(kf.frame)) {
        err("DUPLICATE_KEYFRAME", [...kp, "frame"], `Two keyframes at frame ${kf.frame}`, { otherIndex: frames.get(kf.frame) });
      }
      frames.set(kf.frame, ki);
      if (kf.frame >= scene.duration) {
        warn("KEYFRAME_AFTER_END", [...kp, "frame"], `Keyframe at frame ${kf.frame} is at/after the scene end (duration ${scene.duration})`);
      }
      // value type & range
      const v = kf.value;
      if (spec.kind === "number") {
        if (typeof v !== "number") {
          err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a number, got ${typeof v}`);
        } else {
          if (spec.min !== undefined && v < spec.min) err("VALUE_TOO_SMALL", [...kp, "value"], `"${anim.property}" must be >= ${spec.min}`);
          if (spec.max !== undefined && v > spec.max) err("VALUE_TOO_BIG", [...kp, "value"], `"${anim.property}" must be <= ${spec.max}`);
          if (spec.gt !== undefined && v <= spec.gt) err("VALUE_TOO_SMALL", [...kp, "value"], `"${anim.property}" must be > ${spec.gt}`);
        }
      } else if (spec.kind === "boolean") {
        if (typeof v !== "boolean") err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a boolean`);
      } else if (typeof v !== "string") {
        err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"${anim.property}" needs a string`);
      } else if (anim.property === "asset" && !(v in scene.assets)) {
        err("MISSING_ASSET", [...kp, "value"], `Keyframe references unknown asset "${v}"`, { availableAssets: Object.keys(scene.assets) });
      } else if (anim.property === "fill" && !COLOR_RE.test(v)) {
        err("INVALID_KEYFRAME_VALUE", [...kp, "value"], `"fill" needs a #rrggbb colour`);
      }
      // interpolation
      const interp = kf.interpolation ?? (spec.continuous ? "linear" : "step");
      if (!spec.continuous && interp !== "step") {
        err("INVALID_INTERPOLATION", [...kp, "interpolation"], `"${anim.property}" is discrete and only supports "step" (got "${interp}")`);
      }
      if (interp === "cubic-bezier" && !kf.bezier) {
        err("MISSING_BEZIER", [...kp, "bezier"], `"cubic-bezier" interpolation requires bezier: [x1, y1, x2, y2]`);
      }
      if (kf.bezier && interp !== "cubic-bezier") {
        warn("BEZIER_IGNORED", [...kp, "bezier"], `bezier is only used with "cubic-bezier" interpolation`);
      }
    });
  });

  // --- audio ------------------------------------------------------------------------------
  scene.audio.forEach((a, i) => {
    if (checkFiles && !fs.existsSync(resolveScenePath(options.baseDir, a.src))) {
      err("MISSING_AUDIO_FILE", ["audio", i, "src"], `Audio file not found: ${a.src}`);
    }
    if (a.startFrame >= scene.duration) warn("AUDIO_AFTER_END", ["audio", i, "startFrame"], "Audio starts after the scene ends");
  });

  return errors.length ? { ok: false, errors, warnings } : { ok: true, scene, errors, warnings };
}

export class SceneValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(
      "Scene validation failed:\n" +
        issues.map((i) => `  [${i.code}] ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
    this.name = "SceneValidationError";
  }
}
