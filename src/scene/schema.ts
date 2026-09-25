/**
 * Scene JSON schema (Zod). This is the single contract between whoever authors a scene
 * (a human today, an AI agent later) and the deterministic renderer.
 *
 * Nothing in this file depends on a rendering backend.
 *
 * Coordinate system (see README "Coordinate system" for the full definition):
 *  - Canvas pixels. (0,0) is the top-left corner, (canvas.width, canvas.height) the bottom-right.
 *  - +x points right, +y points down. Rotation is in degrees, positive = clockwise.
 *  - A layer's `x`/`y` is the position of its PIVOT, expressed in its parent's pivot space
 *    (or in world space when it has no parent).
 *  - `anchorX`/`anchorY` choose where the pivot sits inside the layer's own box,
 *    normalised: (0,0) = top-left, (0.5,0.5) = centre, (1,1) = bottom-right.
 *  - `width`/`height` are the base (unscaled) box size. Rendered size = width·scaleX × height·scaleY
 *    (further multiplied by ancestor and camera scale).
 */
import { z } from "zod";

/** Finite number. Zod 4 `z.number()` already rejects NaN and ±Infinity. */
const num = () => z.number();

export const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
export const ColorSchema = z.string().regex(COLOR_RE, "color must be #rgb, #rgba, #rrggbb or #rrggbbaa");

export const ID_RE = /^[A-Za-z_][A-Za-z0-9_\-.]*$/;
export const IdSchema = z.string().regex(ID_RE, "id must start with a letter or _ and contain only letters, digits, _ - .");

/** Reserved animation target that addresses the camera instead of a layer. */
export const CAMERA_TARGET = "camera";

/** Normalised point inside an asset/layer box: (0,0) top-left, (1,1) bottom-right. May lie outside [0,1]. */
export const NormPointSchema = z.object({ x: num(), y: num() }).strict();
export type NormPoint = z.infer<typeof NormPointSchema>;

export const AttachmentPointsSchema = z.record(IdSchema, NormPointSchema);

export const CanvasSchema = z
  .object({
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
    fps: num().gt(0).max(240),
    background: ColorSchema.default("#000000"),
  })
  .strict();

export const AssetSchema = z
  .object({
    /** Image file path, relative to the scene file's directory (or absolute). PNG/JPEG/WebP. */
    src: z.string().min(1),
    /** Named points in normalised asset-box coordinates. */
    attachmentPoints: AttachmentPointsSchema.optional(),
    /** Free-form metadata carried along for tools/agents; ignored by the renderer. */
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CameraSchema = z
  .object({
    /** Camera pan in world pixels. (0,0) = no pan. Positive x moves the camera right (scene slides left). */
    x: num().default(0),
    y: num().default(0),
    /** Zoom factor about the view centre. 1 = no zoom, 2 = everything twice as large. Must be > 0. */
    scale: num().gt(0).default(1),
    /** Camera roll in degrees. Positive rotates the camera clockwise (scene appears counter-clockwise). */
    rotation: num().default(0),
  })
  .strict();

export const MaskSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("layer"),
      /** Id of the layer whose alpha (at its own world transform) masks this layer. */
      layer: IdSchema,
      invert: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("rect"),
      x: num(),
      y: num(),
      width: num().min(0),
      height: num().min(0),
      /** "world": rect in world pixels (camera still applies). "layer": rect in this layer's own box pixels. */
      space: z.enum(["world", "layer"]).default("world"),
      invert: z.boolean().default(false),
    })
    .strict(),
]);

export const LayerSchema = z
  .object({
    id: IdSchema,
    /** Key in `scene.assets`. Omit/null for a pure transform node (group) or a `fill` rectangle. */
    asset: IdSchema.nullable().optional(),
    /** Solid colour rectangle filling the layer box (drawn only when there is no asset). */
    fill: ColorSchema.optional(),
    /** Transform parent (layer id). Controls inherited transform ONLY, never render order. */
    parent: IdSchema.nullable().optional(),
    /**
     * Optional attachment point of the parent to use as this layer's origin instead of the
     * parent's pivot. x/y are then offsets from that point (in the parent's pivot space).
     */
    parentPoint: IdSchema.optional(),

    x: num().default(0),
    y: num().default(0),
    /** Base box size in pixels before scale. Defaults to the asset's natural pixel size (or 0). */
    width: num().min(0).optional(),
    height: num().min(0).optional(),
    scaleX: num().default(1),
    scaleY: num().default(1),
    anchorX: num().min(0).max(1).default(0.5),
    anchorY: num().min(0).max(1).default(0.5),
    rotation: num().default(0),
    opacity: num().min(0).max(1).default(1),
    visible: z.boolean().default(true),
    /** Global render order. Higher draws later (on top). Ties keep document order. */
    z: num().default(0),
    mask: MaskSchema.optional(),
    /** Extra/overriding attachment points in normalised layer-box coordinates. */
    attachmentPoints: AttachmentPointsSchema.optional(),
    /** Free-form notes for agents/tools; ignored by the renderer. */
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const INTERPOLATIONS = ["step", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"] as const;
export const InterpolationSchema = z.enum(INTERPOLATIONS);
export type Interpolation = z.infer<typeof InterpolationSchema>;

export const KeyframeSchema = z
  .object({
    frame: z.number().int().min(0),
    value: z.union([num(), z.string(), z.boolean()]),
    /** Interpolation used from THIS keyframe to the next one. */
    interpolation: InterpolationSchema.optional(),
    /** Control points [x1, y1, x2, y2] for `cubic-bezier` (CSS semantics, x in [0,1]). */
    bezier: z.tuple([num().min(0).max(1), num(), num().min(0).max(1), num()]).optional(),
  })
  .strict();

export const AnimationSchema = z
  .object({
    /** Layer id, or "camera". */
    target: IdSchema,
    property: z.string().min(1),
    keyframes: z.array(KeyframeSchema).min(1),
  })
  .strict();

export const AudioSchema = z
  .object({
    src: z.string().min(1),
    startFrame: z.number().int().min(0).default(0),
    volume: num().min(0).max(10).default(1),
  })
  .strict();

export const SceneSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().optional(),
    canvas: CanvasSchema,
    /** Total length in frames. Frames are numbered 0 .. duration-1. */
    duration: z.number().int().min(1),
    /** Optional seed for any future pseudo-random feature. The core engine uses no randomness. */
    seed: z.number().int().optional(),
    assets: z.record(IdSchema, AssetSchema).default({}),
    camera: CameraSchema.default({ x: 0, y: 0, scale: 1, rotation: 0 }),
    layers: z.array(LayerSchema).default([]),
    animations: z.array(AnimationSchema).default([]),
    audio: z.array(AudioSchema).default([]),
  })
  .strict();

/** Scene as authored (defaults optional). */
export type SceneInput = z.input<typeof SceneSchema>;
/** Scene after parsing (defaults filled in). */
export type Scene = z.output<typeof SceneSchema>;
export type Layer = z.output<typeof LayerSchema>;
export type LayerInput = z.input<typeof LayerSchema>;
export type Asset = z.output<typeof AssetSchema>;
export type Camera = z.output<typeof CameraSchema>;
export type Mask = z.output<typeof MaskSchema>;
export type Keyframe = z.output<typeof KeyframeSchema>;
export type Animation = z.output<typeof AnimationSchema>;
export type AudioTrack = z.output<typeof AudioSchema>;

// ---------------------------------------------------------------------------------------------
// Animatable properties
// ---------------------------------------------------------------------------------------------

export type PropertyKind = "number" | "string" | "boolean";

export interface PropertySpec {
  kind: PropertyKind;
  /** Continuous properties may use any interpolation; discrete ones must use `step`. */
  continuous: boolean;
  min?: number;
  max?: number;
  /** Strict lower bound (value must be > this). */
  gt?: number;
}

export const LAYER_PROPERTIES: Record<string, PropertySpec> = {
  x: { kind: "number", continuous: true },
  y: { kind: "number", continuous: true },
  width: { kind: "number", continuous: true, min: 0 },
  height: { kind: "number", continuous: true, min: 0 },
  scaleX: { kind: "number", continuous: true },
  scaleY: { kind: "number", continuous: true },
  anchorX: { kind: "number", continuous: true, min: 0, max: 1 },
  anchorY: { kind: "number", continuous: true, min: 0, max: 1 },
  rotation: { kind: "number", continuous: true },
  opacity: { kind: "number", continuous: true, min: 0, max: 1 },
  // Discrete properties (step only)
  z: { kind: "number", continuous: false },
  visible: { kind: "boolean", continuous: false },
  asset: { kind: "string", continuous: false },
  fill: { kind: "string", continuous: false },
};

export const CAMERA_PROPERTIES: Record<string, PropertySpec> = {
  x: { kind: "number", continuous: true },
  y: { kind: "number", continuous: true },
  scale: { kind: "number", continuous: true, gt: 0 },
  rotation: { kind: "number", continuous: true },
};
