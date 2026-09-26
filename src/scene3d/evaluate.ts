/**
 * 3D timeline evaluation: 3D scene + frame -> fully resolved state for the renderer.
 *
 * Reuses the 2D keyframe semantics exactly (evaluateTrack: hold before the first / after the last
 * key, per-segment interpolation, clamping), so 2D and 3D share one timing model.
 *
 * Animation clips are evaluated here too, not in the renderer: for every frame the engine decides
 * which clip(s) play, at which clip time (seconds) and with which weight. The renderer only poses
 * the skeleton. Clip rules:
 *  - The active clip is the object's `clip` (from frame 0), overridden by its step `clip` track.
 *    An empty string / null means "no clip" (rest pose).
 *  - Each time the active clip changes a new segment starts; clip time restarts at `clipOffset`:
 *    t = clipOffset + (frame - segmentStart) / fps * clipSpeed, wrapped (clipLoop) or held at the end.
 *  - For `clipBlend` frames after a change the previous clip keeps playing and fades out linearly
 *    (crossfade). Weights that do not sum to 1 blend with the rest pose.
 */
import { evaluateTrack, type CompiledTrack, type TrackValue } from "../timeline/evaluate.js";
import type { ModelInfo } from "./gltf.js";
import { propertySpec3D, type Light3D, type Object3D, type Scene3D, type Target3DKind, type Vec3 } from "./schema.js";

export interface ClipWeight {
  name: string;
  /** Seconds into the clip, measured from its first key. */
  time: number;
  weight: number;
}

export interface Object3DState {
  id: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  /** Active clips (usually one; two while crossfading). Empty = rest pose. */
  clips: ClipWeight[];
  morphs: Record<string, number>;
  /** Active reach IK chains (weight > 0), with target in world metres. */
  ik?: { chain: string; upper: string; lower: string; end: string; target: Vec3; weight: number; grip: number; side: "right" | "left" }[];
}

export interface Light3DState extends Omit<Light3D, "position" | "rotation"> {
  position: Vec3;
  rotation: Vec3;
}

export interface Camera3DState {
  position: Vec3;
  rotation: Vec3;
  /** Point or object/bone to aim at; null = use rotation. */
  lookAt: Vec3 | { object: string; bone?: string } | null;
  fov: number;
  near: number;
  far: number;
}

export interface Frame3DState {
  frame: number;
  camera: Camera3DState;
  world: { color: string; strength: number };
  lights: Light3DState[];
  objects: Object3DState[];
}

export type ModelLookup = (assetId: string) => ModelInfo | undefined;

type Tracks = Map<string, Map<string, CompiledTrack>>;
const compiled = new WeakMap<Scene3D, Tracks>();

function kindOf(scene: Scene3D, target: string): Target3DKind | undefined {
  if (target === "camera" || target === "world") return target;
  if (scene.objects.some((o) => o.id === target)) return "object";
  if (scene.lights.some((l) => l.id === target)) return "light";
  return undefined;
}

export function compileTimeline3D(scene: Scene3D): Tracks {
  const hit = compiled.get(scene);
  if (hit) return hit;
  const tracks: Tracks = new Map();
  for (const anim of scene.animations) {
    const kind = kindOf(scene, anim.target);
    const spec = kind && propertySpec3D(kind, anim.property);
    if (!spec) continue; // rejected by validation
    const keyframes = [...anim.keyframes].sort((a, b) => a.frame - b.frame);
    let m = tracks.get(anim.target);
    if (!m) tracks.set(anim.target, (m = new Map()));
    m.set(anim.property, { target: anim.target, property: anim.property, spec, keyframes });
  }
  compiled.set(scene, tracks);
  return tracks;
}

const vec3 = (get: (p: string, d: number) => number, base: string, d: Vec3): Vec3 => ({
  x: get(`${base}.x`, d.x),
  y: get(`${base}.y`, d.y),
  z: get(`${base}.z`, d.z),
});

/** Clip segments of an object: [startFrame, clipName|null] in frame order. */
export function clipSegments(obj: Object3D, tracks: Tracks): { start: number; clip: string | null }[] {
  const segs: { start: number; clip: string | null }[] = [{ start: 0, clip: obj.clip || null }];
  const track = tracks.get(obj.id)?.get("clip");
  if (track) {
    // before the first key the first key's value holds (same rule as every track)
    segs[0].clip = (track.keyframes[0].value as string) || null;
    for (const kf of track.keyframes.slice(1)) {
      const clip = (kf.value as string) || null;
      if (clip !== segs[segs.length - 1].clip) segs.push({ start: kf.frame, clip });
    }
  }
  return segs;
}

function clipTime(obj: Object3D, model: ModelInfo | undefined, name: string, elapsedFrames: number, fps: number): number {
  const dur = model?.clips.find((c) => c.name === name)?.duration ?? 0;
  const t = obj.clipOffset + (elapsedFrames / fps) * obj.clipSpeed;
  if (dur <= 0) return 0;
  if (obj.clipLoop) return ((t % dur) + dur) % dur;
  return Math.min(t, dur);
}

export function evaluateClips(obj: Object3D, tracks: Tracks, model: ModelInfo | undefined, frame: number, fps: number): ClipWeight[] {
  const segs = clipSegments(obj, tracks);
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].start <= frame) i++;
  const cur = segs[i];
  const out: ClipWeight[] = [];
  const fade = i > 0 && obj.clipBlend > 0 && frame - cur.start < obj.clipBlend ? (frame - cur.start) / obj.clipBlend : 1;
  if (cur.clip) out.push({ name: cur.clip, time: clipTime(obj, model, cur.clip, frame - cur.start, fps), weight: fade });
  if (fade < 1) {
    const prev = segs[i - 1];
    if (prev.clip) out.push({ name: prev.clip, time: clipTime(obj, model, prev.clip, frame - prev.start, fps), weight: 1 - fade });
  }
  return out;
}

export function evaluateScene3D(scene: Scene3D, frame: number, models: ModelLookup): Frame3DState {
  const tracks = compileTimeline3D(scene);
  const getter = (target: string) => {
    const t = tracks.get(target);
    return <T extends TrackValue>(prop: string, fallback: T): T => {
      const tr = t?.get(prop);
      return tr ? (evaluateTrack(tr, frame) as T) : fallback;
    };
  };
  const fps = scene.canvas.fps;

  const cv = getter("camera");
  const cam = scene.camera;
  const lookAtAnimated = ["x", "y", "z"].some((a) => tracks.get("camera")?.has(`lookAt.${a}`));
  let lookAt: Camera3DState["lookAt"] = cam.lookAt ?? null;
  if (lookAtAnimated) {
    const base = lookAt && "x" in lookAt ? lookAt : { x: 0, y: 0, z: 0 };
    lookAt = vec3(cv, "lookAt", base);
  }
  const camera: Camera3DState = {
    position: vec3(cv, "position", cam.position),
    rotation: vec3(cv, "rotation", cam.rotation),
    lookAt,
    fov: cv("fov", cam.fov),
    near: cam.near,
    far: cam.far,
  };

  const wv = getter("world");
  const world = { color: wv("color", scene.world.color), strength: wv("strength", scene.world.strength) };

  const lights = scene.lights.map((l): Light3DState => {
    const v = getter(l.id);
    return { ...l, position: vec3(v, "position", l.position), rotation: vec3(v, "rotation", l.rotation), color: v("color", l.color), intensity: v("intensity", l.intensity) };
  });

  const objects = scene.objects.map((o): Object3DState => {
    const v = getter(o.id);
    const model = o.asset ? models(o.asset) : undefined;
    const morphs: Record<string, number> = { ...o.morphs };
    const ik = Object.entries(o.ik ?? {})
      .map(([chain, c]) => ({
        chain,
        upper: c.upper,
        lower: c.lower,
        end: c.end,
        grip: c.grip,
        side: c.side,
        target: vec3(v, `ik.${chain}.target`, c.target),
        weight: v(`ik.${chain}.weight`, c.weight),
      }))
      .filter((c) => c.weight > 0);
    for (const prop of tracks.get(o.id)?.keys() ?? []) {
      if (prop.startsWith("morph.")) morphs[prop.slice(6)] = v(prop, 0);
    }
    return {
      id: o.id,
      position: vec3(v, "position", o.position),
      rotation: vec3(v, "rotation", o.rotation),
      scale: vec3(v, "scale", o.scale),
      visible: v("visible", o.visible),
      ...(ik.length ? { ik } : {}),
      clips: evaluateClips(o, tracks, model, frame, fps),
      morphs,
    };
  });

  return { frame, camera, world, lights, objects };
}
