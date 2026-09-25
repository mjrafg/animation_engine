/**
 * 3D scene schema. A 3D scene is a sibling of the 2D scene: same canvas, duration, keyframe and
 * audio schemas (one timing system), but its own object model, clearly marked with kind: "3d".
 * 2D scene documents (no `kind`) are unaffected.
 *
 * Coordinates follow glTF: metres, right-handed, +Y up, -Z is "into the screen" for the default
 * camera; a model's front faces +Z. Rotations are Euler angles in DEGREES: x is applied first,
 * then y, then z, each about the parent's fixed axes (matrix Rz·Ry·Rx). The engine owns the
 * timeline; the 3D renderer only draws the evaluated state.
 */
import { z } from "zod";
import { AnimationSchema, AudioSchema, CanvasSchema, ColorSchema, IdSchema } from "../scene/schema.js";
import type { PropertySpec } from "../scene/schema.js";

const num = () => z.number();

export const Vec3Schema = z.object({ x: num(), y: num(), z: num() }).strict();
export type Vec3 = z.infer<typeof Vec3Schema>;
const vec = (x: number, y: number, zz: number) => Vec3Schema.default({ x, y: y, z: zz });

export const RESERVED_3D_TARGETS = ["camera", "world"] as const;

export const PrimitiveSchema = z
  .object({
    shape: z
      .enum(["plane", "box", "sphere", "cylinder"])
      .describe("plane lies flat on the XZ ground plane (normal +Y), centred on the object position; box/sphere/cylinder stand ON the position (their origin is the bottom centre, like a model's feet)."),
    size: Vec3Schema.optional().describe("Size in metres along x (width), y (height), z (depth). plane uses x and z (default 10 x 10); sphere uses x as diameter; box/sphere/cylinder default 1 m."),
    color: ColorSchema.default("#bbbbbb"),
    roughness: num().min(0).max(1).default(0.6),
    metallic: num().min(0).max(1).default(0),
  })
  .strict();

export const AttachSchema = z
  .object({
    object: IdSchema.describe("Id of a rigged model object in this scene."),
    bone: z.string().min(1).describe("Joint name or semantic socket (rightHand, leftHand, head, neck, spine, hips, root, rightFoot, ...)."),
    follow: z.enum(["full", "position"]).default("full").describe("full: follow the bone's position and rotation; position: follow only its position."),
  })
  .strict()
  .describe("Attach this object to a bone of another object. Its position/rotation are then offsets in the bone's local frame (metres/degrees); it follows the bone through animation.");

export const Object3DSchema = z
  .object({
    id: IdSchema,
    asset: IdSchema.optional().describe("Model asset id (a .glb/.gltf asset). Omit for a primitive or an empty group."),
    primitive: PrimitiveSchema.optional().describe("Simple built-in geometry (floor, walls, boxes) instead of an asset."),
    parent: IdSchema.nullable().optional().describe("Transform parent object id (inherits its position/rotation/scale)."),
    attach: AttachSchema.optional(),
    position: vec(0, 0, 0).describe("Metres, glTF axes: +x right, +y up, +z toward the default camera."),
    rotation: vec(0, 0, 0).describe("Degrees about x, y, z (x first, then y, then z, about fixed axes). Models face +z (toward the default camera); y=90 faces +x (screen right), y=180 faces away."),
    scale: vec(1, 1, 1),
    visible: z.boolean().default(true),
    clip: z.string().nullable().optional().describe("Animation clip playing from frame 0 (see the asset's clips). Change it over time with a 'clip' keyframe track."),
    clipSpeed: num().gt(0).max(20).default(1).describe("Playback speed of clips (1 = authored speed)."),
    clipLoop: z.boolean().default(true).describe("Loop clips; false holds the last pose."),
    clipOffset: num().min(0).default(0).describe("Seconds into the clip at its start."),
    clipBlend: z.number().int().min(0).max(120).default(8).describe("Frames of crossfade when the clip changes."),
    morphs: z.record(z.string(), num().min(0).max(1)).optional().describe("Morph target (blend shape) weights 0..1 by name, e.g. {mouth_open: 0.5}."),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const Light3DSchema = z
  .object({
    id: IdSchema,
    type: z.enum(["sun", "point", "spot", "area"]).describe("sun: parallel light (only rotation matters); point/spot/area: positioned lights."),
    position: vec(0, 3, 3),
    rotation: vec(-45, 0, 0).describe("Degrees; lights shine along their local -Z (like the camera)."),
    color: ColorSchema.default("#ffffff"),
    intensity: num().min(0).describe("sun: strength (W/m², typical 1-5); point/spot/area: power in watts (typical 100-2000)."),
    size: num().min(0).default(0.25).describe("Light size in metres (soft shadows); sun: angular size in degrees."),
    spotAngle: num().gt(0).max(180).default(45).describe("spot only: cone angle in degrees."),
    shadows: z.boolean().default(true),
  })
  .strict();

export const Camera3DSchema = z
  .object({
    position: vec(0, 1.6, 6),
    rotation: vec(0, 0, 0).describe("Degrees. (0,0,0) looks straight along -Z with +Y up. Ignored while lookAt is set."),
    lookAt: z
      .union([Vec3Schema, z.object({ object: IdSchema, bone: z.string().optional() }).strict()])
      .nullable()
      .optional()
      .describe("Aim the camera at a point {x,y,z} or at an object (optionally one of its bones/sockets). Overrides rotation."),
    fov: num().gt(1).lt(170).default(40).describe("Vertical field of view in degrees."),
    near: num().gt(0).default(0.05),
    far: num().gt(0).default(500),
  })
  .strict();

export const World3DSchema = z
  .object({
    color: ColorSchema.default("#aab8c8").describe("Ambient/background world colour."),
    strength: num().min(0).default(1).describe("Ambient light strength."),
  })
  .strict();

export const Render3DSchema = z
  .object({
    quality: z.enum(["draft", "standard", "high"]).default("standard").describe("draft: fastest (previews); standard: soft shadows (video); high: ambient occlusion, sharper shadows, more samples (slower)."),
    engine: z
      .enum(["cycles", "eevee", "workbench"])
      .optional()
      .describe("Advanced: force a renderer. Default: eevee (fast raster) when the machine has an OpenGL/EGL stack, otherwise cycles (CPU path tracer, several times slower)."),
    samples: z.number().int().min(1).max(4096).optional().describe("Advanced: override samples per pixel."),
    transparentBackground: z.boolean().default(false).describe("Render the world as transparent (alpha) instead of its colour."),
  })
  .strict();

export const Scene3DSchema = z
  .object({
    version: z.literal(1).default(1),
    kind: z.literal("3d"),
    name: z.string().optional(),
    canvas: CanvasSchema,
    duration: z.number().int().min(1),
    render: Render3DSchema.default({ quality: "standard", transparentBackground: false }),
    world: World3DSchema.default({ color: "#aab8c8", strength: 1 }),
    camera: Camera3DSchema.default({ position: { x: 0, y: 1.6, z: 6 }, rotation: { x: 0, y: 0, z: 0 }, fov: 40, near: 0.05, far: 500 }),
    lights: z.array(Light3DSchema).default([]),
    objects: z.array(Object3DSchema).default([]),
    animations: z.array(AnimationSchema).default([]),
    audio: z.array(AudioSchema).default([]),
    overlay: z
      .object({ scene: IdSchema.describe("Id of a 2D scene in the same workspace (same canvas size and fps) drawn on top of every frame.") })
      .strict()
      .optional()
      .describe("Hybrid: composite a 2D scene (titles, infographics, images) over the 3D render. Give the 2D scene a transparent background (#00000000)."),
  })
  .strict();

export type Scene3D = z.output<typeof Scene3DSchema>;
export type Object3D = z.output<typeof Object3DSchema>;
export type Light3D = z.output<typeof Light3DSchema>;

// ---- animatable properties -------------------------------------------------------------------

const cont = (extra: Partial<PropertySpec> = {}): PropertySpec => ({ kind: "number", continuous: true, ...extra });
const XYZ = (p: string) => Object.fromEntries(["x", "y", "z"].map((a) => [`${p}.${a}`, cont()]));

export const OBJECT3D_PROPERTIES: Record<string, PropertySpec> = {
  ...XYZ("position"),
  ...XYZ("rotation"),
  ...XYZ("scale"),
  visible: { kind: "boolean", continuous: false },
  clip: { kind: "string", continuous: false },
  // morph.<name> is resolved dynamically (continuous, 0..1)
};
export const CAMERA3D_PROPERTIES: Record<string, PropertySpec> = {
  ...XYZ("position"),
  ...XYZ("rotation"),
  ...XYZ("lookAt"),
  fov: cont({ gt: 1, max: 169 }),
};
export const LIGHT3D_PROPERTIES: Record<string, PropertySpec> = {
  ...XYZ("position"),
  ...XYZ("rotation"),
  intensity: cont({ min: 0 }),
  color: { kind: "string", continuous: false },
};
export const WORLD3D_PROPERTIES: Record<string, PropertySpec> = {
  strength: cont({ min: 0 }),
  color: { kind: "string", continuous: false },
};

export type Target3DKind = "object" | "light" | "camera" | "world";

/** Property spec for a target kind, including dynamic morph.<name> properties on objects. */
export function propertySpec3D(kind: Target3DKind, property: string): PropertySpec | undefined {
  if (kind === "object") {
    if (property.startsWith("morph.") && property.length > 6) return cont({ min: 0, max: 1 });
    return OBJECT3D_PROPERTIES[property];
  }
  if (kind === "camera") return CAMERA3D_PROPERTIES[property];
  if (kind === "light") return LIGHT3D_PROPERTIES[property];
  return WORLD3D_PROPERTIES[property];
}

export function propertyList3D(kind: Target3DKind): string[] {
  const t = { object: OBJECT3D_PROPERTIES, camera: CAMERA3D_PROPERTIES, light: LIGHT3D_PROPERTIES, world: WORLD3D_PROPERTIES }[kind];
  return [...Object.keys(t), ...(kind === "object" ? ["morph.<name>"] : [])];
}
