/**
 * Builds backend jobs from a validated 3D scene: static structure (models, primitives, parents,
 * attachments) once, plus the engine-evaluated state of every requested frame.
 */
import { EngineError } from "../errors.js";
import { runBlenderJob, type BlenderEvent } from "./blender.js";
import { evaluateScene3D, type Frame3DState } from "./evaluate.js";
import type { ModelInfo } from "./gltf.js";
import type { Scene3D } from "./schema.js";
import { resolveBone } from "./validate.js";

export interface Scene3DContext {
  scene: Scene3D;
  model: (assetId: string) => ModelInfo | undefined;
  /** Absolute file path of a model asset. */
  assetFile: (assetId: string) => string;
}

export interface Render3DOptions {
  signal?: AbortSignal;
  onFrame?: (frame: number, file: string) => void;
  /** Override quality (e.g. "draft" for previews). */
  quality?: "draft" | "standard" | "high";
}

function staticJob(ctx: Scene3DContext, mode: string, quality?: string) {
  const s = ctx.scene;
  return {
    mode,
    width: s.canvas.width,
    height: s.canvas.height,
    fps: s.canvas.fps,
    render: {
      quality: quality ?? s.render.quality,
      engine: s.render.engine ?? "cycles",
      ...(s.render.samples ? { samples: s.render.samples } : {}),
      transparent: s.render.transparentBackground,
      device: process.env.VIDEO_ENGINE_3D_DEVICE === "GPU" ? "GPU" : "CPU",
    },
    camera: { near: s.camera.near, far: s.camera.far },
    lights: s.lights.map((l) => ({ id: l.id, type: l.type, size: l.size, spotAngle: l.spotAngle, shadows: l.shadows })),
    objects: s.objects.map((o) => {
      const model = o.asset ? ctx.model(o.asset) : undefined;
      let attach: Record<string, unknown> | undefined;
      if (o.attach) {
        const bone = resolveBone(ctx.model(ctx.scene.objects.find((x) => x.id === o.attach!.object)?.asset ?? ""), o.attach.bone);
        attach = { object: o.attach.object, bone, follow: o.attach.follow };
      }
      return {
        id: o.id,
        asset: o.asset ? ctx.assetFile(o.asset) : null,
        primitive: o.primitive ?? null,
        parent: o.parent ?? null,
        ...(attach ? { attach } : {}),
        clipDurations: Object.fromEntries((model?.clips ?? []).map((c) => [c.name, c.duration])),
      };
    }),
  };
}

/** Evaluated state with bone/socket names resolved to joint names for the backend. */
export function frameState(ctx: Scene3DContext, frame: number): Frame3DState {
  const st = evaluateScene3D(ctx.scene, frame, ctx.model);
  const la = st.camera.lookAt;
  if (la && "object" in la && la.bone) {
    const obj = ctx.scene.objects.find((o) => o.id === la.object);
    const bone = resolveBone(obj?.asset ? ctx.model(obj.asset) : undefined, la.bone);
    st.camera.lookAt = { object: la.object, ...(bone ? { bone } : {}) };
  }
  return st;
}

function checkFrame(ctx: Scene3DContext, frame: number) {
  if (!Number.isInteger(frame) || frame < 0 || frame >= ctx.scene.duration) {
    throw new EngineError("INVALID_FRAME", `Frame ${frame} is outside the scene (0..${ctx.scene.duration - 1})`, { frame, duration: ctx.scene.duration });
  }
}

export interface Measure3DOptions {
  /** Object ids to report (default all). */
  objects?: string[];
  /** Extra bones (joint or socket names) to report per rigged object, besides all detected sockets. */
  bones?: string[];
}

function bonesRequest(ctx: Scene3DContext, extra: string[] = []) {
  const bones: Record<string, Record<string, string>> = {};
  for (const obj of ctx.scene.objects) {
    const model = obj.asset ? ctx.model(obj.asset) : undefined;
    if (!model?.rigged) continue;
    const want: Record<string, string> = { ...model.sockets };
    for (const b of extra) {
      const j = resolveBone(model, b);
      if (j) want[b] = j;
    }
    bones[obj.id] = want;
  }
  return bones;
}

function checkObjects(ctx: Scene3DContext, ids: string[] = []) {
  for (const id of ids) {
    if (!ctx.scene.objects.some((x) => x.id === id)) {
      throw new EngineError("LAYER_NOT_FOUND", `No object "${id}" in this scene`, { objectId: id, available: ctx.scene.objects.map((x) => x.id) });
    }
  }
}

export type Measurement3D = Awaited<ReturnType<typeof shapeMeasurement>>;

function shapeMeasurement(ctx: Scene3DContext, m: BlenderEvent, only?: string[]) {
  const s = ctx.scene;
  const sel = only ? new Set(only) : null;
  const objects = (m.objects as any[])
    .filter((r) => !sel || sel.has(r.id))
    .map((r) => {
      const spec = s.objects.find((x) => x.id === r.id)!;
      return { id: r.id, asset: spec.asset ?? null, primitive: spec.primitive?.shape ?? null, parent: spec.parent ?? null, attach: spec.attach ?? null, ...r };
    });
  return {
    frame: m.frame as number,
    canvas: { width: s.canvas.width, height: s.canvas.height },
    objects,
    camera: m.camera as Record<string, unknown>,
    lights: m.lights as Record<string, unknown>[],
  };
}

/**
 * Renders the given frames to PNG files (one Blender process for all of them). With `measure`,
 * every rendered frame is also measured (used by debug previews).
 */
export async function renderFrames3D(
  ctx: Scene3DContext,
  frames: { frame: number; out: string }[],
  o: Render3DOptions & { measure?: Measure3DOptions } = {},
): Promise<{ events: BlenderEvent[]; measurements: Measurement3D[] }> {
  for (const f of frames) checkFrame(ctx, f.frame);
  if (o.measure) checkObjects(ctx, o.measure.objects);
  const job = {
    ...staticJob(ctx, "render", o.quality),
    frames: frames.map((f) => ({ frame: f.frame, out: f.out, state: frameState(ctx, f.frame) })),
    ...(o.measure ? { measure: true, bones: bonesRequest(ctx, o.measure.bones) } : {}),
  };
  const events = await runBlenderJob(job, {
    signal: o.signal,
    onEvent: (e) => {
      if (e.event === "frame") o.onFrame?.(e.frame, e.file);
    },
  });
  const measurements = events.filter((e) => e.event === "measure").map((e) => shapeMeasurement(ctx, e, o.measure?.objects));
  return { events, measurements };
}

/**
 * 3D inspection (the 3D equivalent of measure_layout): world transforms, world bounds, projected
 * screen bounds, on-screen state and depth, camera-space position, bone/socket positions, active
 * clips and asset identity for every object at `frame`.
 */
export async function measure3D(ctx: Scene3DContext, frame: number, o: Measure3DOptions = {}): Promise<Measurement3D> {
  checkFrame(ctx, frame);
  checkObjects(ctx, o.objects);
  const job = { ...staticJob(ctx, "measure", "draft"), frame, state: frameState(ctx, frame), bones: bonesRequest(ctx, o.bones) };
  const events = await runBlenderJob(job);
  const m = events.find((e) => e.event === "measure");
  if (!m) throw new EngineError("RENDER_FAILED", "3D backend returned no measurement");
  return shapeMeasurement(ctx, m, o.objects);
}

/** Renders a framed thumbnail of a model file and returns Blender-side import facts. */
export async function modelThumbnail(file: string, out: string, size = { width: 640, height: 480 }) {
  const job = {
    mode: "thumbnail",
    asset: file,
    out,
    width: size.width,
    height: size.height,
    fps: 24,
    render: { quality: "draft", engine: "workbench", transparent: false },
  };
  const events = await runBlenderJob(job, { idleTimeoutMs: 120_000 });
  const t = events.find((e) => e.event === "thumbnail");
  if (!t) throw new EngineError("RENDER_FAILED", "3D backend returned no thumbnail");
  const { event: _e, file: _f, ...info } = t;
  return info as { blenderObjects: number; clipsFound: string[]; bones: number; bounds?: unknown };
}
