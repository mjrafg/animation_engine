/**
 * Engine capability discovery. Everything here is DERIVED from the engine's own tables and
 * schemas (animatable property tables, interpolation list, mask union, timeline op union,
 * exported processing functions), so the description stays accurate as the engine evolves:
 * adding a property to LAYER_PROPERTIES or an interpolation to INTERPOLATIONS shows up here
 * automatically.
 */
import { createRequire } from "node:module";
import { TimelineOpSchema } from "./api/operations.js";
import { findComponents, removeComponents } from "./assets/components.js";
import { inspectImage, processAsset } from "./assets/pipeline.js";
import { removeBackground } from "./assets/removal.js";
import { trimTransparent } from "./assets/trim.js";
import { buildDebugOverlay } from "./engine/debugOverlay.js";
import { measureResolvedLayout } from "./engine/layout.js";
import { SkiaRenderer } from "./render/skia.js";
import { blenderInfo } from "./scene3d/blender.js";
import { COMPOSITION_RULES } from "./characters/capabilities.js";
import { KIND_CHANNEL } from "./characters/plan.js";
import { VISEMES } from "./characters/schema.js";
import { BUILTIN_INTERACTIONS, PHASES } from "./characters/interaction-defs.js";
import {
  CAMERA3D_PROPERTIES,
  LIGHT3D_PROPERTIES,
  Light3DSchema,
  OBJECT3D_PROPERTIES,
  Object3DSchema,
  PrimitiveSchema,
  Render3DSchema,
  WORLD3D_PROPERTIES,
} from "./scene3d/schema.js";
import {
  CAMERA_PROPERTIES,
  CanvasSchema,
  INTERPOLATIONS,
  LAYER_PROPERTIES,
  LayerSchema,
  MaskSchema,
  type PropertySpec,
} from "./scene/schema.js";

const require = createRequire(import.meta.url);

export function engineVersion(): { name: string; version: string } {
  try {
    const pkg = require("animation-engine/package.json") as { name: string; version: string };
    return { name: pkg.name, version: pkg.version };
  } catch {
    return { name: "animation-engine", version: "unknown" };
  }
}

const fn = (f: unknown) => typeof f === "function";

function describeProps(table: Record<string, PropertySpec>) {
  return Object.fromEntries(
    Object.entries(table).map(([k, s]) => [
      k,
      {
        type: s.kind,
        interpolation: s.continuous ? "continuous" : "discrete (step only)",
        ...(s.min !== undefined ? { min: s.min } : {}),
        ...(s.max !== undefined ? { max: s.max } : {}),
        ...(s.gt !== undefined ? { greaterThan: s.gt } : {}),
      },
    ]),
  );
}

export function engineCapabilities() {
  const maskTypes = MaskSchema.options.map((o) => o.shape.type.value);
  const timelineOps = TimelineOpSchema.options.map((o) => o.shape.type.value);
  const layerFields = Object.keys(LayerSchema.shape);
  const canvasMax = (CanvasSchema.shape.width as any).maxValue ?? 8192;
  const easing = INTERPOLATIONS.filter((i) => i !== "step" && i !== "linear");
  return {
    engine: engineVersion(),
    coordinateSystem: {
      units: "pixels",
      origin: "top-left of the canvas; +x right, +y down",
      rotation: "degrees, positive = clockwise",
      position: "layer x/y = position of the layer's pivot, in its parent's pivot space (world space for root layers)",
      anchor: "anchorX/anchorY in [0,1] pick the pivot inside the layer box: 0,0 top-left, 0.5,0.5 centre, 1,1 bottom-right",
      size: "width/height are the unscaled box size; rendered size = width*scaleX x height*scaleY (times ancestor and camera scale)",
      frames: "integers 0 .. duration-1; seconds = frame / fps",
    },
    scene: {
      globalZ: true,
      globalZNote: "draw order is by z across the whole scene (ties: layer order); parent/child never groups rendering",
      parentTransforms: true,
      parentPoints: layerFields.includes("parentPoint"),
      attachmentPoints: layerFields.includes("attachmentPoints"),
      masks: maskTypes.length > 0,
      maskTypes,
      camera: true,
      cameraProperties: Object.keys(CAMERA_PROPERTIES),
      layerSources: ["asset", "fill", "group (no asset/fill: transform-only node)"],
      layerFields,
      maxCanvasSize: canvasMax,
      text: layerFields.includes("text"),
      audioTracks: true,
    },
    animation: {
      interpolations: [...INTERPOLATIONS],
      step: INTERPOLATIONS.includes("step"),
      linear: INTERPOLATIONS.includes("linear"),
      easing: easing.length > 0,
      easings: easing,
      layerProperties: describeProps(LAYER_PROPERTIES),
      cameraProperties: describeProps(CAMERA_PROPERTIES),
      batchOperations: timelineOps,
      atomicBatches: true,
    },
    assets: {
      inspect: fn(inspectImage),
      nativeAlpha: fn(processAsset),
      backgroundRemoval: fn(removeBackground),
      backgroundRemovalMethod:
        "border color detection + edge-connected flood fill (enclosed key-colored regions are kept unless removed by id)",
      despill: fn(removeBackground),
      transparentTrim: fn(trimTransparent),
      componentDetection: fn(findComponents),
      componentRemoval: fn(removeComponents),
      nonDestructive: true,
    },
    layout: { measure: fn(measureResolvedLayout), worldAndScreenSpace: true, attachmentPointWorldCoordinates: true },
    render: {
      renderer: new SkiaRenderer().name,
      preview: true,
      debugPreview: fn(buildDebugOverlay),
      frame: true,
      video: true,
      videoCodec: "h264 (yuv420p) in MP4",
      audioMux: "aac",
      deterministic: true,
    },
    threeD: capabilities3D(),
    characters: {
      runtime: true,
      summary:
        "Prepared characters (2D or 3D) are imported once and driven by high-level actions (what, when, how long, where); the runtime compiles them onto the normal timeline.",
      actionKinds: Object.keys(KIND_CHANNEL),
      channels: [...new Set(Object.values(KIND_CHANNEL))],
      compositionRules: COMPOSITION_RULES,
      visemes: [...VISEMES],
      speechInput: "provider-neutral: visemes | character alignment | word alignment | none (deterministic generic talking)",
      tools: [
        "character_list",
        "character_import",
        "character_inspect",
        "character_add",
        "character_update",
        "character_remove",
        "character_actions",
        "character_timeline",
        "speech_timing_save",
      ],
    },
    interactions: {
      runtime: true,
      summary:
        "Multi-character interactions (handshake, high_five, hug, give_object, receive_object, push, or custom definitions) between placed characters: the runtime aligns the actors, schedules approach/turn/hold, drives the arms to the contact targets (2D and 3D two-bone IK) and switches object ownership, all compiled into the actors' timeline content.",
      builtin: Object.keys(BUILTIN_INTERACTIONS),
      phases: [...PHASES],
      ownsChannels: "locomotion, facing and the arms it uses, for its actors, during the interaction",
      concurrent: "talk (mouth), expressions, blinks keep working; each character's speech, mouth, expression and audio are independent",
      custom:
        "interaction_define: same JSON schema as the built-ins (roles, duration, alignment, phases, targets, effectors, moves, transfer), stored per workspace",
      limits:
        "no physics, collisions, motion planning or full-body IK; arms only reach as far as they are long (INTERACTION_OUT_OF_REACH warning)",
      tools: ["interaction_list", "interaction_check", "interaction_define", "interaction_apply", "interaction_inspect"],
    },
  };
}

/** 3D section: conventions, object model, animatable properties (from the 3D tables) and backend. */
export function capabilities3D() {
  const b = blenderInfo();
  return {
    available: b.available,
    backend: { name: "blender", version: b.version, ...(b.available ? {} : { problem: b.error, install: "see docs/3D.md" }) },
    sceneKind: "create with scene_create kind:'3d'; 2D scenes are unchanged",
    coordinateSystem: {
      units: "metres",
      axes: "right-handed, +y up, +x right, +z toward the default camera (glTF convention)",
      modelFront: "+z (rotation.y = 90 faces +x, 180 faces away from the camera)",
      rotation: "degrees; x applied first, then y, then z, about fixed axes",
      camera:
        "looks along its -z; rotation (0,0,0) looks at -z with +y up; lookAt (point or object/bone) overrides rotation; fov = vertical degrees",
      screen: "measurements give screen pixels with origin top-left like 2D, plus depth in metres",
    },
    objects: {
      sources: ["asset (GLB/glTF model)", "primitive: " + PrimitiveSchema.shape.shape.options.join(" | "), "empty group (neither)"],
      fields: Object.keys(Object3DSchema.shape),
      parenting: "parent = transform inheritance",
      attachments:
        "attach {object, bone|socket, follow full|position}: follows the bone through animation; offsets are in the target's own space at its rest pose",
      sockets: [
        "rightHand",
        "leftHand",
        "head",
        "neck",
        "spine",
        "chest",
        "hips",
        "root",
        "rightFoot",
        "leftFoot",
        "... (detected from joint names; asset_inspect lists a model's sockets)",
      ],
      clips: "clip + a step 'clip' track select animation clips; clipSpeed/clipLoop/clipOffset; clipBlend frames crossfade between clips",
      morphTargets: "morphs {name: 0..1} and 'morph.<name>' tracks (face shapes such as smile, blink, mouth_open when the model has them)",
    },
    lights: { types: Light3DSchema.shape.type.options, fields: Object.keys(Light3DSchema.shape) },
    animation: {
      objectProperties: {
        ...describeProps(OBJECT3D_PROPERTIES),
        "morph.<name>": { type: "number", interpolation: "continuous", min: 0, max: 1 },
      },
      cameraProperties: describeProps(CAMERA3D_PROPERTIES),
      lightProperties: describeProps(LIGHT3D_PROPERTIES),
      worldProperties: describeProps(WORLD3D_PROPERTIES),
      targets: "object or light id, 'camera', 'world'",
      sameTimelineAs2D: true,
    },
    render: {
      quality: Render3DSchema.shape.quality.unwrap().options,
      engines: "eevee (fast raster, needs EGL/OpenGL) when available, otherwise cycles (CPU path tracer)",
      overlay2D: "overlay {scene: <2D scene id>} composites a 2D scene (transparent background) over every 3D frame",
      audio: true,
      transparentBackground: true,
    },
    inspection:
      "measure_layout on a 3D scene: world transform, world bounds, screen bounds/onScreen/visibleFraction, camera-space depth, bone/socket world+screen positions, active clips, asset id",
  };
}

export type EngineCapabilities = ReturnType<typeof engineCapabilities>;
