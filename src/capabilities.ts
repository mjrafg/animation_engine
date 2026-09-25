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
    const pkg = require("../package.json") as { name: string; version: string };
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
      backgroundRemovalMethod: "border color detection + edge-connected flood fill (enclosed key-colored regions are kept unless removed by id)",
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
  };
}

export type EngineCapabilities = ReturnType<typeof engineCapabilities>;
