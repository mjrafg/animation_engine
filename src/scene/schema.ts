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
import { CharacterInstanceSchema, InteractionInstanceSchema } from "../characters/schema.js";

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

export const VideoMetadataSchema = z.object({
  width: z.number().int().positive(), height: z.number().int().positive(),
  fps: num().gt(0).max(240), frameCount: z.number().int().positive(), duration: num().gt(0),
  preparedBy: z.literal("prepare_video_asset@1"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;

export const AssetSchema = z
  .object({
    /** Image file path, relative to the scene file's directory (or absolute). PNG/JPEG/WebP. */
    src: z.string().min(1),
    kind: z.enum(["image", "video"]).optional(),
    video: VideoMetadataSchema.optional(),
    /** Named points in normalised asset-box coordinates. */
    attachmentPoints: AttachmentPointsSchema.optional(),
    /** Free-form metadata carried along for tools/agents; ignored by the renderer. */
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const CameraSchema = z
  .object({
    x: num().default(0).describe("Pan in world px. 0 = none; +x moves the camera right (the scene slides left). The view centre looks at world (width/2 + x, height/2 + y)."),
    y: num().default(0).describe("Pan in world px; +y moves the camera down."),
    scale: num().gt(0).default(1).describe("Zoom about the view centre: 1 = none, 2 = everything twice as large. Must be > 0."),
    rotation: num().default(0).describe("Camera roll in degrees; positive turns the camera clockwise (scene appears counter-clockwise)."),
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

export const ShapeSchema = z.object({
  type: z.enum(["rect", "ellipse", "path"]),
  d: z.string().max(65536).optional(),
  cornerRadius: num().min(0).optional(),
  fill: ColorSchema.nullable().optional(),
  stroke: ColorSchema.nullable().optional(),
  strokeWidth: num().min(0).optional(),
  strokeAlign: z.enum(["inside", "center", "outside"]).optional(),
  feather: num().min(0).max(256).optional(),
  shadow: z.object({ color: ColorSchema, blur: num().min(0).max(256), x: num(), y: num() }).strict().optional(),
}).strict();
export type Shape = z.infer<typeof ShapeSchema>;

export const LayerSchema = z
  .object({
    id: IdSchema.describe("Unique layer id within the scene."),
    asset: IdSchema.nullable()
      .optional()
      .describe("Id of the image asset this layer shows. Omit for a transform-only group node or a `fill` rectangle."),
    shape: ShapeSchema.optional(),
    space: z.enum(["world", "screen"]).optional(),
    sourceTime: num().optional(),
    fill: ColorSchema.optional().describe("Solid colour rectangle filling the layer box (#rrggbb). Used only when there is no asset."),
    parent: IdSchema.nullable()
      .optional()
      .describe(
        "Transform parent layer id. The layer inherits the parent's position/rotation/scale (and opacity/visibility). It does NOT affect render order: that is `z` only.",
      ),
    parentPoint: IdSchema.optional().describe(
      "Name of an attachment point on the parent. When set, x/y are offsets from that point instead of from the parent's pivot.",
    ),
    x: num().default(0).describe("X of this layer's PIVOT, in the parent's pivot space (canvas pixels for root layers)."),
    y: num().default(0).describe("Y of this layer's PIVOT (+y is down)."),
    width: num()
      .min(0)
      .optional()
      .describe("Unscaled box width in px. Defaults to the asset's pixel width (0 for groups). Rendered width = width*scaleX."),
    height: num().min(0).optional().describe("Unscaled box height in px. Defaults to the asset's pixel height."),
    scaleX: num().default(1).describe("Horizontal scale about the pivot. Negative mirrors."),
    scaleY: num().default(1).describe("Vertical scale about the pivot."),
    anchorX: num()
      .min(0)
      .max(1)
      .default(0.5)
      .describe("Pivot position inside the box: 0 = left edge, 0.5 = centre, 1 = right edge. Rotation/scale happen around the pivot."),
    anchorY: num().min(0).max(1).default(0.5).describe("Pivot position inside the box: 0 = top edge, 0.5 = centre, 1 = bottom edge."),
    rotation: num().default(0).describe("Degrees, positive = clockwise, around the pivot. Added to the parent's rotation."),
    opacity: num().min(0).max(1).default(1).describe("0..1, multiplied by ancestors' opacity."),
    visible: z.boolean().default(true).describe("false hides this layer and all its descendants."),
    z: num()
      .default(0)
      .describe(
        "GLOBAL render order across the whole scene: higher draws on top; ties keep layer order. A child can have a higher or lower z than its parent or than unrelated layers.",
      ),
    mask: MaskSchema.optional().describe(
      "Optional mask: {type:'rect', x,y,width,height, space:'world'|'layer'} or {type:'layer', layer:<id>} (uses that layer's alpha).",
    ),
    attachmentPoints: AttachmentPointsSchema.optional().describe(
      "Named points {name:{x,y}} in normalised box coordinates (0,0 top-left, 1,1 bottom-right); override the asset's points.",
    ),
    meta: z.record(z.string(), z.unknown()).optional().describe("Free-form notes; ignored by the renderer."),
  })
  .strict();

export const INTERPOLATIONS = ["step", "linear", "ease-in", "ease-out", "ease-in-out", "cubic-bezier"] as const;
export const InterpolationSchema = z.enum(INTERPOLATIONS);
export type Interpolation = z.infer<typeof InterpolationSchema>;

export const KeyframeSchema = z
  .object({
    frame: z.number().int().min(0).describe("Frame number (integer, 0-based)."),
    value: z.union([num(), z.string(), z.boolean()]).describe("Number for continuous properties; asset id string for `asset`; boolean for `visible`."),
    interpolation: InterpolationSchema.optional().describe(
      "How to move from THIS keyframe to the next: step | linear | ease-in | ease-out | ease-in-out | cubic-bezier. Default linear (continuous) or step (discrete: asset, visible, z, fill).",
    ),
    bezier: z
      .tuple([num().min(0).max(1), num(), num().min(0).max(1), num()])
      .optional()
      .describe("[x1,y1,x2,y2] control points for cubic-bezier (CSS semantics)."),
  })
  .strict();

export const AnimationSchema = z
  .object({
    /** Layer id, or "camera". */
    target: IdSchema,
    property: z.string().min(1),
    keyframes: z.array(KeyframeSchema).min(1),
    owner: z.string().optional().describe("Set on tracks generated by a character instance (its id). Edit those through character actions; recompiling replaces them."),
  })
  .strict();

export const AudioSchema = z
  .object({
    src: z.string().min(1),
    startFrame: z.number().int().min(0).default(0),
    sourceIn: num().min(0).optional(),
    sourceOut: num().gt(0).optional(),
    startOffsetMs: num().min(0).optional(),
    fadeInMs: num().min(0).optional(),
    fadeOutMs: num().min(0).optional(),
    volume: num().min(0).max(10).default(1),
    owner: z.string().optional().describe("Set on audio added by a character instance (speech)."),
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
    interactions: z.array(InteractionInstanceSchema).optional().describe("Multi-character interactions (handshake, hug, give_object, ...) between character instances; compiled into the actors' generated content."),
    characters: z
      .array(CharacterInstanceSchema)
      .optional()
      .describe("Prepared characters placed in the scene with their high-level actions; compiled into layers and tracks owned by each instance."),
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
  cornerRadius: { kind: "number", continuous: true, min: 0 },
  strokeWidth: { kind: "number", continuous: true, min: 0 },
  shadowBlur: { kind: "number", continuous: true, min: 0, max: 256 },
  stroke: { kind: "string", continuous: false },
  shapeFill: { kind: "string", continuous: false },
  sourceTime: { kind: "number", continuous: true },
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
