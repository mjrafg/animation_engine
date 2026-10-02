/**
 * Timeline evaluation: scene + frame number -> fully resolved property values.
 *
 * Semantics:
 *  - A track overrides the layer's/camera's static value for that property at every frame.
 *  - Before the first keyframe the first value holds; after the last keyframe the last value holds.
 *  - A keyframe's `interpolation` controls the segment from that keyframe to the NEXT one.
 *    Default is "linear" for continuous properties and "step" for discrete ones.
 *  - `step` holds the left keyframe's value until the frame of the next keyframe (inclusive switch).
 *  - Bounded properties (opacity, anchors, camera scale, sizes) are clamped after easing, so an
 *    overshooting cubic-bezier can never produce an invalid value.
 *  - Time is purely frame based: no clocks, no randomness. Fractional frames are allowed.
 */
import {
  CAMERA_PROPERTIES,
  CAMERA_TARGET,
  LAYER_PROPERTIES,
  type Keyframe,
  type Layer,
  type Shape,
  type Mask,
  type NormPoint,
  type PropertySpec,
  type Scene,
} from "../scene/schema.js";
import { easingFor } from "./easing.js";

export type TrackValue = number | string | boolean;

export interface CompiledTrack {
  target: string;
  property: string;
  spec: PropertySpec;
  keyframes: Keyframe[]; // sorted by frame
}

export interface CompiledTimeline {
  /** target -> property -> track */
  tracks: Map<string, Map<string, CompiledTrack>>;
}

const timelineCache = new WeakMap<Scene, CompiledTimeline>();

export function compileTimeline(scene: Scene): CompiledTimeline {
  const cached = timelineCache.get(scene);
  if (cached) return cached;
  const tracks = new Map<string, Map<string, CompiledTrack>>();
  for (const anim of scene.animations) {
    const table = anim.target === CAMERA_TARGET ? CAMERA_PROPERTIES : LAYER_PROPERTIES;
    const spec = table[anim.property];
    if (!spec) continue; // rejected by validation
    const keyframes = [...anim.keyframes].sort((a, b) => a.frame - b.frame);
    let m = tracks.get(anim.target);
    if (!m) tracks.set(anim.target, (m = new Map()));
    m.set(anim.property, { target: anim.target, property: anim.property, spec, keyframes });
  }
  const compiled = { tracks };
  timelineCache.set(scene, compiled);
  return compiled;
}

function clampToSpec(v: number, spec: PropertySpec): number {
  if (spec.min !== undefined && v < spec.min) v = spec.min;
  if (spec.max !== undefined && v > spec.max) v = spec.max;
  if (spec.gt !== undefined && v <= spec.gt) v = spec.gt + 1e-6;
  return v;
}

export function evaluateTrack(track: CompiledTrack, frame: number): TrackValue {
  const kfs = track.keyframes;
  if (frame <= kfs[0].frame) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (frame >= last.frame) return last.value;
  // binary search for the segment [i, i+1] with kfs[i].frame <= frame < kfs[i+1].frame
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].frame <= frame) lo = mid;
    else hi = mid;
  }
  const k0 = kfs[lo];
  const k1 = kfs[hi];
  const interp = k0.interpolation ?? (track.spec.continuous ? "linear" : "step");
  if (interp === "step" || !track.spec.continuous || typeof k0.value !== "number" || typeof k1.value !== "number") {
    return k0.value;
  }
  const t = (frame - k0.frame) / (k1.frame - k0.frame);
  const e = easingFor(interp, k0.bezier)(t);
  return clampToSpec(k0.value + (k1.value - k0.value) * e, track.spec);
}

export interface CameraState {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export interface LayerState {
  id: string;
  /** Index in scene.layers (document order; used as the z tie-breaker). */
  index: number;
  asset: string | null;
  shape?: Shape;
  space?: "world" | "screen";
  sourceTime?: number;
  sourceFrame?: number;
  fill: string | null;
  parent: string | null;
  parentPoint: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  anchorX: number;
  anchorY: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  z: number;
  mask: Mask | null;
  /** Merged attachment points (asset's, overridden by the layer's), normalised to the layer box. */
  attachmentPoints: Record<string, NormPoint>;
}

export interface FrameState {
  frame: number;
  camera: CameraState;
  layers: LayerState[];
  byId: Map<string, LayerState>;
}

/** Natural pixel size of an asset, used when a layer omits width/height. */
export type AssetSizeLookup = (assetId: string) => { width: number; height: number } | undefined;

export function evaluateScene(scene: Scene, frame: number, assetSize: AssetSizeLookup): FrameState {
  const timeline = compileTimeline(scene);

  const camTracks = timeline.tracks.get(CAMERA_TARGET);
  const camera: CameraState = { ...scene.camera };
  if (camTracks) {
    for (const [prop, track] of camTracks) {
      (camera as unknown as Record<string, TrackValue>)[prop] = evaluateTrack(track, frame);
    }
  }

  const layers: LayerState[] = scene.layers.map((layer: Layer, index) => {
    const tracks = timeline.tracks.get(layer.id);
    const v = <T extends TrackValue>(prop: string, fallback: T): T => {
      const t = tracks?.get(prop);
      return t ? (evaluateTrack(t, frame) as T) : fallback;
    };
    const asset = v<string>("asset", layer.asset ?? "") || null;
    const natural = asset ? assetSize(asset) : undefined;
    const assetPoints = asset ? scene.assets[asset]?.attachmentPoints : undefined;
    const video = asset && scene.assets[asset]?.kind === "video" ? scene.assets[asset]?.video : undefined;
    const sourceTime = v("sourceTime", layer.sourceTime ?? 0);
    return {
      ...(video ? { sourceTime, sourceFrame: Math.max(0, Math.min(video.frameCount - 1, Math.floor(sourceTime * video.fps + 1e-6))) } : {}),
      id: layer.id,
      index,
      ...(layer.space ? { space: layer.space } : {}),
      ...(layer.shape ? { shape: {
        ...layer.shape,
        cornerRadius: v("cornerRadius", layer.shape.cornerRadius ?? 0),
        strokeWidth: v("strokeWidth", layer.shape.strokeWidth ?? 1),
        fill: tracks?.has("shapeFill") ? v("shapeFill", "") : layer.shape.fill,
        stroke: tracks?.has("stroke") ? v("stroke", "") : layer.shape.stroke,
        ...(layer.shape.shadow ? { shadow: { ...layer.shape.shadow, blur: v("shadowBlur", layer.shape.shadow.blur) } } : {}),
      } } : {}),
      asset,
      fill: v<string>("fill", layer.fill ?? "") || null,
      parent: layer.parent ?? null,
      parentPoint: layer.parentPoint ?? null,
      x: v("x", layer.x),
      y: v("y", layer.y),
      width: v("width", layer.width ?? natural?.width ?? 0),
      height: v("height", layer.height ?? natural?.height ?? 0),
      scaleX: v("scaleX", layer.scaleX),
      scaleY: v("scaleY", layer.scaleY),
      anchorX: v("anchorX", layer.anchorX),
      anchorY: v("anchorY", layer.anchorY),
      rotation: v("rotation", layer.rotation),
      opacity: v("opacity", layer.opacity),
      visible: v("visible", layer.visible),
      z: v("z", layer.z),
      mask: layer.mask ?? null,
      attachmentPoints: { ...assetPoints, ...layer.attachmentPoints },
    };
  });

  return { frame, camera, layers, byId: new Map(layers.map((l) => [l.id, l])) };
}
