/**
 * MCP tool definitions. Each tool is a thin adapter: validate the arguments (Zod, reusing the
 * core engine schemas), call the core API (WorkspaceManager / VideoWorkspace / scene operations /
 * RenderJobs), and shape the result. No scene logic lives here.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import { z } from "zod";
import * as ops from "../../src/api/operations.js";
import { engineCapabilities, engineVersion } from "../../src/capabilities.js";
import { EngineError } from "../../src/errors.js";
import type { FrameLayout } from "../../src/engine/layout.js";
import { ffmpegPath } from "../../src/render/video.js";
import { CameraSchema, CanvasSchema, ColorSchema, IdSchema, LayerSchema } from "../../src/scene/schema.js";
import { blenderInfo, engineWorks } from "../../src/scene3d/blender.js";
import * as ops3d from "../../src/scene3d/operations.js";
import type { Measurement3D } from "../../src/scene3d/render.js";
import { AttachSchema, Camera3DSchema, Light3DSchema, Object3DSchema, PrimitiveSchema, Render3DSchema, Vec3Schema, World3DSchema } from "../../src/scene3d/schema.js";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager, type ArtifactRecord, type VideoWorkspace } from "../../src/workspace/workspace.js";
import type { ServerContext } from "./context.js";

export const SERVER_NAME = "video-engine";
export const SERVER_VERSION = "1.0.0";

export interface ToolDef {
  name: string;
  description: string;
  args: z.ZodObject<any>;
  /** `raw` = the arguments as sent (before schema defaults), stored as-is in scene documents. */
  handler: (ctx: ServerContext, args: any, raw?: any) => Promise<Record<string, unknown>>;
  /** Mutating tools are logged with their scene/asset ids. */
  mutates?: boolean;
}

const tools: ToolDef[] = [];
const def = (t: ToolDef) => tools.push(t);

// ---------------------------------------------------------------------------------------------
// shared argument pieces

const WorkspaceId = z.string().describe("Workspace id (from workspace_create / workspace_list). Every workspace is isolated.");
const SceneId = IdSchema.describe("Scene id.");
const AssetId = IdSchema.describe("Asset id (see asset_list).");
const FrameArg = z.number().int().min(0).describe("Frame number, 0-based integer (< scene duration). Seconds = frame / fps.");
const NewAssetId = IdSchema.optional().describe("Optional id for the new derived asset (default: <source>_<operation>).");

/** Patch schema = every layer field optional, null = remove the field (restore default). No defaults injected. */
const LayerPatchSchema = z
  .object(
    Object.fromEntries(
      Object.entries(LayerSchema.omit({ id: true }).shape).map(([k, v]) => {
        const base = v instanceof z.ZodDefault ? (v as z.ZodDefault<any>).unwrap() : v;
        return [k, (base as z.ZodType).nullable().optional()];
      }),
    ),
  )
  .strict()
  .describe("Fields to change; several at once are applied atomically. null removes a field (restores its default).");

const CanvasPatch = z
  .object({
    width: CanvasSchema.shape.width.optional(),
    height: CanvasSchema.shape.height.optional(),
    fps: CanvasSchema.shape.fps.optional(),
    background: ColorSchema.optional().describe("Canvas colour behind all layers (#rrggbb)."),
  })
  .strict()
  .describe("Output canvas. Defaults: 1920x1080, 30 fps, black.");

const CameraPatch = z
  .object({ x: CameraSchema.shape.x.unwrap().optional(), y: CameraSchema.shape.y.unwrap().optional(), scale: CameraSchema.shape.scale.unwrap().optional(), rotation: CameraSchema.shape.rotation.unwrap().optional() })
  .strict()
  .describe("Static camera. Animate it with timeline_apply target 'camera' (properties x, y, scale, rotation).");

const AudioArg = z
  .array(
    z
      .object({
        assetId: AssetId,
        startFrame: z.number().int().min(0).optional().describe("Frame at which the audio starts (default 0)."),
        volume: z.number().min(0).max(10).optional().describe("Gain, default 1."),
      })
      .strict(),
  )
  .describe("Audio tracks (audio assets) mixed into rendered videos. Replaces the current list.");

// ---------------------------------------------------------------------------------------------
// result shaping

const r2 = (n: number) => Math.round(n * 100) / 100;
const rp = (p: { x: number; y: number }) => ({ x: r2(p.x), y: r2(p.y) });
const rb = (b: { left: number; top: number; right: number; bottom: number }) => ({ left: r2(b.left), top: r2(b.top), right: r2(b.right), bottom: r2(b.bottom) });

function presentArtifact(ws: VideoWorkspace, a: ArtifactRecord) {
  const { view, ...rest } = a;
  return {
    ...rest,
    workspaceId: ws.id,
    path: ws.abs(a.relativePath),
    ...(view ? { viewPath: ws.abs(view.relativePath), view } : {}),
  };
}

function compactLayout(l: FrameLayout, detail: "compact" | "full") {
  if (detail === "full") return l;
  return {
    frame: l.frame,
    canvas: { width: l.canvas.width, height: l.canvas.height },
    camera: { x: r2(l.camera.x), y: r2(l.camera.y), scale: r2(l.camera.scale), rotation: r2(l.camera.rotation) },
    drawOrder: l.drawOrder,
    layers: l.layers.map((x) => ({
      id: x.id,
      parent: x.parent,
      asset: x.asset,
      z: x.z,
      drawIndex: x.drawIndex,
      visible: x.visible,
      opacity: r2(x.opacity),
      size: x.size,
      worldPivot: rp(x.worldPivot),
      worldCenter: rp(x.worldCenter),
      worldBounds: rb(x.worldBounds),
      worldRotation: r2(x.worldRotation),
      screenBounds: rb(x.screenBounds),
      onScreen: x.onScreen,
      ...(Object.keys(x.attachmentPoints).length
        ? { attachmentPoints: Object.fromEntries(Object.entries(x.attachmentPoints).map(([k, v]) => [k, { world: rp(v.world), screen: rp(v.screen) }])) }
        : {}),
    })),
  };
}

function layerSummary(doc: ops.SceneDoc) {
  const animated = new Map<string, string[]>();
  for (const a of doc.animations ?? []) animated.set(a.target, [...(animated.get(a.target) ?? []), a.property]);
  return (doc.layers ?? []).map((l: any) => ({ ...l, ...(animated.get(l.id) ? { animated: animated.get(l.id) } : {}) }));
}

// ---------------------------------------------------------------------------------------------
// engine

def({
  name: "engine_capabilities",
  description:
    "Describe what the video engine supports: coordinate conventions (read these first), scene features (global z, parent transforms, masks, camera), animatable properties with their interpolation rules, timeline batch operation types, asset processing and render outputs. Derived from the engine itself. Also lists this server's asset libraries and whether it is locked to one workspace.",
  args: z.object({}).strict(),
  handler: async (ctx) => ({
    summary: "Engine capabilities",
    ...engineCapabilities(),
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      assignedWorkspace: ctx.config.lockedWorkspace ?? null,
      libraries: ctx.manager.libraryNames(),
      renderJobs: { asynchronous: true, maxConcurrentPerWorkspace: ctx.config.maxRenders, statusLongPollMaxSeconds: 45 },
    },
  }),
});

def({
  name: "engine_version",
  description: "Engine and MCP server versions.",
  args: z.object({}).strict(),
  handler: async () => ({ summary: `${engineVersion().name} ${engineVersion().version}`, engine: engineVersion(), server: { name: SERVER_NAME, version: SERVER_VERSION } }),
});

export async function healthCheck(ctx: { config: { root: string } }, deep: boolean) {
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  const ff = ffmpegPath();
  const v = spawnSync(ff, ["-version"], { encoding: "utf8", timeout: 15_000 });
  checks.ffmpeg = v.status === 0 ? { ok: true, detail: v.stdout.split("\n")[0] } : { ok: false, detail: `${ff}: ${v.error?.message ?? v.stderr}` };
  try {
    const c = createCanvas(4, 4);
    c.getContext("2d").fillRect(0, 0, 2, 2);
    await c.encode("png");
    checks.renderer = { ok: true, detail: "skia canvas ok" };
  } catch (e) {
    checks.renderer = { ok: false, detail: String(e) };
  }
  checks.imageIO = { ok: true, detail: `sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}` };
  try {
    fs.mkdirSync(ctx.config.root, { recursive: true });
    fs.accessSync(ctx.config.root, fs.constants.W_OK);
    checks.workspaceRoot = { ok: true, detail: "writable" };
  } catch (e) {
    checks.workspaceRoot = { ok: false, detail: String(e) };
  }
  const b = blenderInfo();
  const threeD = b.available
    ? { ok: true, detail: `Blender ${b.version} (${b.path}); renderer: ${(await engineWorks("eevee")) ? "eevee (EGL)" : "cycles (CPU; EEVEE/EGL unavailable)"}` }
    : { ok: false, detail: `3D backend unavailable: ${b.error}. 2D is unaffected. Install: apt install blender python3-numpy libegl1 libegl-mesa0 libgl1-mesa-dri` };
  if (deep) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vem-health-"));
    try {
      const ws = new WorkspaceManager({ root: tmp }).create("health");
      await ws.createScene({ sceneId: "s", canvas: { width: 64, height: 36, fps: 10 }, duration: 5 });
      await ws.mutateScene("s", (d) => ops.addLayers(d, [{ id: "box", fill: "#ff8800", width: 20, height: 20, x: 32, y: 18 }]));
      await ws.renderPreview("s", 0);
      const jobs = new RenderJobs(ws);
      const j = await jobs.wait((await jobs.start("s")).renderId, 30_000);
      checks.endToEndRender = j.status === "completed" ? { ok: true, detail: `rendered ${j.totalFrames} frames to MP4` } : { ok: false, detail: JSON.stringify(j.error) };
      if (b.available) {
        await ws.createScene({ sceneId: "s3", kind: "3d", canvas: { width: 64, height: 36, fps: 12 }, duration: 2 });
        await ws.mutateScene("s3", (d) => ops3d.addEntities3D(d, { objects: [{ id: "box", primitive: { shape: "box", color: "#ff8800" } }], lights: [{ id: "sun", type: "sun", intensity: 3 }] }));
        await ws.mutateScene("s3", (d) => ops3d.setSettings3D(d, { render: { quality: "draft" }, camera: { lookAt: { object: "box" } } }));
        const t = Date.now();
        await ws.renderPreview("s3", 0);
        threeD.detail += `; test render ok (${((Date.now() - t) / 1000).toFixed(1)} s)`;
      }
    } catch (e) {
      checks.endToEndRender = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const ok = Object.values(checks).every((c) => c.ok);
  // 3D is optional: its absence does not make the (2D) server unhealthy
  checks.threeD = threeD;
  return { summary: ok ? (threeD.ok ? "healthy (2D + 3D)" : "healthy (2D only; 3D unavailable)") : "UNHEALTHY", ok, checks, node: process.version, platform: `${process.platform}-${process.arch}` };
}

def({
  name: "engine_health",
  description: "Check that FFmpeg, the Skia renderer, image I/O, the workspace root and the optional 3D backend (Blender) work. deep=true also renders and encodes a tiny test video and, when 3D is available, a tiny 3D frame.",
  args: z.object({ deep: z.boolean().optional().describe("Also run a real render + MP4 encode.") }).strict(),
  handler: async (ctx, a) => healthCheck(ctx, !!a.deep),
});

// ---------------------------------------------------------------------------------------------
// workspaces

function workspaceInfo(ws: VideoWorkspace) {
  return { ...ws.info(), inboxPath: ws.abs("inbox") };
}

def({
  name: "workspace_create",
  description:
    "Create an isolated video workspace (assets, scenes, renders). Every other tool takes its workspaceId. Returns inboxPath: a directory where files you generate can be placed and then imported with asset_import {source:{inbox:'<file name>'}}.",
  args: z.object({ workspaceId: WorkspaceId, name: z.string().max(200).optional().describe("Display name.") }).strict(),
  mutates: true,
  handler: async (ctx, a) => ({ summary: `Workspace ${a.workspaceId} created`, ...workspaceInfo(ctx.manager.create(a.workspaceId, { name: a.name })) }),
});

def({
  name: "workspace_open",
  description: "Open an existing workspace (create=true creates it if missing) and return its summary: asset count, scene ids, artifacts, inbox files, available libraries.",
  args: z.object({ workspaceId: WorkspaceId, create: z.boolean().optional().describe("Create the workspace if it does not exist.") }).strict(),
  handler: async (ctx, a) => ({ summary: `Workspace ${a.workspaceId}`, ...workspaceInfo(ctx.manager.open(a.workspaceId, { create: a.create })) }),
});

def({
  name: "workspace_info",
  description: "Summary of a workspace: assets, scenes, artifacts, files waiting in its inbox.",
  args: z.object({ workspaceId: WorkspaceId }).strict(),
  handler: async (ctx, a) => ({ summary: `Workspace ${a.workspaceId}`, ...workspaceInfo(ctx.workspace(a.workspaceId)) }),
});

def({
  name: "workspace_list",
  description: "List the workspaces this server can access.",
  args: z.object({}).strict(),
  handler: async (ctx) => {
    const list = ctx.manager.list();
    return { summary: `${list.length} workspace(s)`, workspaces: list, assignedWorkspace: ctx.config.lockedWorkspace ?? null };
  },
});

// ---------------------------------------------------------------------------------------------
// assets

def({
  name: "library_list",
  description: "List read-only asset libraries configured on this server, or the image/audio/3D model files inside one (paths are relative to the library; import them with asset_import).",
  args: z
    .object({
      library: z.string().optional().describe("Library name; omit to list library names."),
      subdir: z.string().optional().describe("Relative sub-directory to list."),
    })
    .strict(),
  handler: async (ctx, a) => {
    if (!a.library) return { summary: `${ctx.manager.libraryNames().length} library(ies)`, libraries: ctx.manager.libraryNames() };
    const files = ctx.manager.listLibrary(a.library, { subdir: a.subdir });
    return { summary: `${files.length} file(s) in ${a.library}`, library: a.library, files };
  },
});

def({
  name: "asset_import",
  description:
    "Add an image (png/jpg/webp), audio file (wav/mp3/...) or 3D model (glb, or gltf with embedded data) to the workspace as an asset with a stable id. Models are validated and described (clips, sockets, morph targets). Source is exactly one of: {library, path} (read-only library file), {inbox: '<relative path in the workspace inbox>'}, or {base64, filename} (small files). Importing identical content again returns the existing asset (reused=true). Scenes reference assets by id, so one asset can be used by many layers/scenes without copies.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      source: z
        .union([
          z.object({ library: z.string(), path: z.string().describe("Path relative to the library root.") }).strict(),
          z.object({ inbox: z.string().describe("Path relative to the workspace inbox directory.") }).strict(),
          z.object({ base64: z.string().max(14_000_000), filename: z.string().describe("Name with extension, e.g. 'cup.png'.") }).strict(),
        ])
        .describe("Where the file comes from. Host paths are not accepted."),
      assetId: IdSchema.optional().describe("Optional id; default derived from the file name."),
      name: z.string().max(200).optional(),
      tags: z.array(z.string().max(60)).max(20).optional(),
      attachmentPoints: z
        .record(IdSchema, z.object({ x: z.number(), y: z.number() }).strict())
        .optional()
        .describe("Named points in normalised image coordinates (0,0 top-left .. 1,1 bottom-right), usable as parentPoint by child layers."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const s = a.source;
    let r;
    if ("library" in s) {
      r = await ws.importAsset({ kind: "file", file: ctx.manager.resolveLibraryFile(s.library, s.path), origin: { library: s.library, path: s.path } }, a);
    } else if ("inbox" in s) {
      const file = ws.abs(path.posix.join("inbox", s.inbox));
      if (!file.startsWith(ws.abs("inbox") + path.sep)) throw new EngineError("PATH_OUTSIDE_WORKSPACE", `Inbox path escapes the inbox: ${s.inbox}`);
      if (!fs.existsSync(file)) throw new EngineError("FILE_NOT_FOUND", `No file "${s.inbox}" in the inbox`, { inbox: ws.listInbox() });
      r = await ws.importAsset({ kind: "file", file, origin: { inbox: s.inbox } }, a);
    } else {
      r = await ws.importAsset({ kind: "bytes", data: Buffer.from(s.base64, "base64"), filename: s.filename, origin: { upload: s.filename } }, a);
    }
    return { summary: `${r.reused ? "Reused existing" : "Imported"} ${r.asset.kind} asset ${r.asset.assetId}`, reused: r.reused, asset: r.asset.model ? { ...r.asset, model: modelSummary(r.asset.model) } : r.asset };
  },
});

def({
  name: "asset_list",
  description: "List assets in a workspace (id, kind, size, alpha, tags, provenance operation).",
  args: z.object({ workspaceId: WorkspaceId, kind: z.enum(["image", "audio", "model"]).optional(), tag: z.string().optional() }).strict(),
  handler: async (ctx, a) => {
    const list = ctx.workspace(a.workspaceId).listAssets(a);
    return {
      summary: `${list.length} asset(s)`,
      assets: list.map((x) => ({
        assetId: x.assetId, name: x.name, kind: x.kind, width: x.width, height: x.height, hasAlpha: x.hasAlpha, tags: x.tags,
        operation: x.provenance.operation, ...(x.provenance.sourceAssetId ? { sourceAssetId: x.provenance.sourceAssetId } : {}),
        ...(x.attachmentPoints ? { attachmentPoints: x.attachmentPoints } : {}),
        ...(x.model ? { clips: x.model.clips.map((c) => c.name), rigged: x.model.rigged, morphTargets: x.model.morphTargets } : {}),
      })),
    };
  },
});

def({
  name: "asset_get",
  description: "Full record of one asset: size, alpha, attachment points, provenance (source asset, processing options and diagnostics).",
  args: z.object({ workspaceId: WorkspaceId, assetId: AssetId }).strict(),
  handler: async (ctx, a) => ({ summary: `Asset ${a.assetId}`, asset: ctx.workspace(a.workspaceId).getAsset(a.assetId) }),
});

def({
  name: "asset_update",
  description: "Change an asset's name, tags or attachment points (normalised 0..1 image coordinates). The image itself never changes; layers using it pick up new attachment points.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      assetId: AssetId,
      name: z.string().max(200).optional(),
      tags: z.array(z.string().max(60)).max(20).optional(),
      attachmentPoints: z.record(IdSchema, z.object({ x: z.number(), y: z.number() }).strict()).nullable().optional().describe("Replaces all points; null removes them."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => ({ summary: `Asset ${a.assetId} updated`, asset: ctx.workspace(a.workspaceId).updateAsset(a.assetId, a) }),
});

def({
  name: "asset_inspect",
  description:
    "3D model: clips (name, seconds), rigged, sockets (rightHand, head, ... -> joint), joints, morph targets, bind-pose bounds in metres, plus a rendered thumbnail viewPath. Image: analyse without changing it: size, alpha statistics, border background colour/uniformity, visible bounds and suggestedPath ('native-alpha' = already transparent -> asset_trim; 'color-key' = solid background -> asset_process; 'opaque' = full-frame plate, use as is). Returns viewPath: a small JPEG (checkerboard = transparency) to look at.",
  args: z.object({ workspaceId: WorkspaceId, assetId: AssetId }).strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.inspectAsset(a.assetId);
    return {
      summary: `Asset ${a.assetId}: ${r.inspection ? r.inspection.suggestedPath : r.asset.model ? `model, clips ${r.asset.model.clips.map((c) => c.name).join(", ") || "none"}` : r.asset.kind}`,
      ...r,
      ...(r.view ? { viewPath: ws.abs(r.view.relativePath) } : {}),
    };
  },
});

const ProcessOptions = z
  .object({
    mode: z.enum(["auto", "transparent", "color-key"]).optional().describe("auto (default): transparent images are only validated+trimmed; solid backgrounds are removed."),
    detect: z
      .object({
        borderSampleSize: z.number().int().min(1).max(200).optional().describe("Border band sampled for the background colour (px, default 12)."),
        uniformityTolerance: z.number().min(0).max(100).optional().describe("Delta-E for border pixels to count as background (default 12)."),
        minUniformity: z.number().min(0).max(1).optional().describe("Required background share of the border (default 0.9)."),
      })
      .strict()
      .optional(),
    removal: z
      .object({
        colorTolerance: z.number().min(0).max(100).optional().describe("Delta-E flood-fill tolerance (default 18)."),
        edgeSoftness: z.number().int().min(0).max(20).optional().describe("Soft-edge band width in px (default 3; 0 = hard cut)."),
        despill: z.boolean().optional().describe("Remove background colour fringe from edges (default true)."),
        removeHoles: z.union([z.array(z.number().int()), z.literal("all")]).optional().describe("Enclosed background-coloured regions to remove too (ids from a previous run's diagnostics.holes, or 'all')."),
      })
      .strict()
      .optional(),
    trim: z.object({ alphaThreshold: z.number().min(0).max(254).optional(), padding: z.number().int().min(0).max(500).optional() }).strict().optional(),
    removeComponents: z.array(z.number().int()).optional().describe("Disconnected component ids to delete (from a previous run's diagnostics.components)."),
    attachmentPointsPx: z.record(IdSchema, z.object({ x: z.number(), y: z.number() }).strict()).optional().describe("Named points in SOURCE image pixels; converted to the new asset's normalised coordinates."),
    force: z.boolean().optional().describe("Process even if the border is not a uniform solid colour."),
  })
  .strict();

def({
  name: "asset_process",
  description:
    "Make a transparent, trimmed asset from an image: detects a solid background colour from the image border, removes only background connected to the edges (edge-connected flood fill, so same-coloured regions inside the subject survive), softens and despills edges, then trims. Already-transparent images are validated and trimmed. Creates a NEW asset; the source is untouched. diagnostics lists enclosed holes and disconnected components (ids) you can remove on a re-run. Returns viewPath of the result.",
  args: z.object({ workspaceId: WorkspaceId, assetId: AssetId, newAssetId: NewAssetId, options: ProcessOptions.optional() }).strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.processAsset(a.assetId, a.options ?? {}, { assetId: a.newAssetId });
    return { summary: `Processed ${a.assetId} -> ${r.asset.assetId} (${r.asset.width}x${r.asset.height})`, asset: r.asset, diagnostics: r.diagnostics, viewPath: ws.abs(r.view.relativePath), view: r.view };
  },
});

def({
  name: "asset_trim",
  description: "Crop an image asset to its visible (non-transparent) pixels, keeping optional padding. Creates a NEW asset; attachment points are carried over. Returns trim offsets and viewPath.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      assetId: AssetId,
      newAssetId: NewAssetId,
      alphaThreshold: z.number().min(0).max(254).optional().describe("Pixels with alpha <= this count as empty (default 4)."),
      padding: z.number().int().min(0).max(500).optional().describe("Transparent margin to keep (px, default 0)."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.trimAsset(a.assetId, { alphaThreshold: a.alphaThreshold, padding: a.padding }, { assetId: a.newAssetId });
    return { summary: `Trimmed ${a.assetId} -> ${r.asset.assetId} (${r.asset.width}x${r.asset.height})`, asset: r.asset, trim: r.trim, viewPath: ws.abs(r.view.relativePath), view: r.view };
  },
});

def({
  name: "asset_components",
  description: "List disconnected visible regions (8-connected alpha components) of an image asset: id (1 = largest), pixelCount, bounds, centroid, share. Use to find stray specks after background removal.",
  args: z.object({ workspaceId: WorkspaceId, assetId: AssetId, alphaThreshold: z.number().min(0).max(254).optional().describe("Default 8.") }).strict(),
  handler: async (ctx, a) => {
    const c = await ctx.workspace(a.workspaceId).assetComponents(a.assetId, a.alphaThreshold);
    return { summary: `${c.length} component(s)`, components: c };
  },
});

def({
  name: "asset_component_remove",
  description: "Create a NEW asset with the given component ids (from asset_components) made transparent. The source asset is untouched.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      assetId: AssetId,
      componentIds: z.array(z.number().int().min(1)).min(1),
      newAssetId: NewAssetId,
      alphaThreshold: z.number().min(0).max(254).optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.removeAssetComponents(a.assetId, a.componentIds, a.alphaThreshold, { assetId: a.newAssetId });
    return { summary: `Removed ${a.componentIds.length} component(s): ${r.asset.assetId}`, asset: r.asset, removedPixels: r.removedPixels, viewPath: ws.abs(r.view.relativePath), view: r.view };
  },
});

// ---------------------------------------------------------------------------------------------
// scenes

def({
  name: "scene_create",
  description:
    "Create an empty scene. kind '2d' (default): canvas pixels, origin top-left, +y down, rotation degrees clockwise; add layers with layer_add. kind '3d': metres, +y up, models face +z (toward the default camera); add models/primitives/lights with object_add, set camera/world/render with scene_settings_3d (default canvas 1280x720 @ 24 fps). Both kinds: frames 0..duration-1, animation with timeline_apply, audio with scene_update, render_* and measure_layout work on both.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: IdSchema.optional().describe("Optional id (default scene_N)."),
      kind: z.enum(["2d", "3d"]).optional().describe("2d (default) or 3d."),
      name: z.string().max(200).optional(),
      canvas: CanvasPatch.optional(),
      duration: z.number().int().min(1).max(216000).optional().describe("Length in frames (default 5 seconds)."),
      camera: CameraPatch.optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    if (a.kind === "3d" && a.camera) throw new EngineError("INVALID_ARGUMENT", "camera here is the 2D camera; set the 3D camera with scene_settings_3d");
    const r = await ws.createScene(a);
    const doc = ws.getSceneDoc(r.sceneId);
    return { summary: `${r.kind.toUpperCase()} scene ${r.sceneId} created (${doc.canvas.width}x${doc.canvas.height}, ${doc.duration} frames @ ${doc.canvas.fps} fps)`, sceneId: r.sceneId, kind: r.kind, canvas: doc.canvas, duration: doc.duration, warnings: r.warnings };
  },
});

def({
  name: "scene_get",
  description: "The full scene: canvas, duration, camera, layers (engine fields), animation tracks, audio (by assetId) and assetsUsed. Layers reference assets by id in their `asset` field.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  handler: async (ctx, a) => {
    const v = ctx.workspace(a.workspaceId).sceneView(a.sceneId);
    const n = (v as any).kind === "3d" ? `${(v as any).objects?.length ?? 0} objects, ${(v as any).lights?.length ?? 0} lights` : `${(v as any).layers?.length ?? 0} layers`;
    return { summary: `Scene ${a.sceneId} (${(v as any).kind}): ${n}, ${(v as any).animations?.length ?? 0} tracks`, scene: v };
  },
});

def({
  name: "scene_list",
  description: "List scenes in a workspace with canvas, duration, layer and track counts.",
  args: z.object({ workspaceId: WorkspaceId }).strict(),
  handler: async (ctx, a) => {
    const list = ctx.workspace(a.workspaceId).listScenes();
    return { summary: `${list.length} scene(s)`, scenes: list };
  },
});

def({
  name: "scene_update",
  description: "Change scene-level settings in one atomic step: name, canvas (size/fps/background), duration (frames), static camera, audio tracks. Layer and animation changes use the layer_* and timeline_apply tools.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      name: z.string().max(200).optional(),
      canvas: CanvasPatch.optional(),
      duration: z.number().int().min(1).max(216000).optional(),
      camera: CameraPatch.optional(),
      audio: AudioArg.optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const audio = a.audio ? ws.audioEntries(a.audio) : undefined;
    if (a.camera && ws.sceneKind(a.sceneId) === "3d") throw new EngineError("INVALID_ARGUMENT", "This is a 3D scene: set its camera with scene_settings_3d");
    const r = await ws.mutateScene(a.sceneId, (doc) => {
      let cur: ops.OpResult = { ok: true, scene: doc, warnings: [] };
      if (a.name !== undefined || a.canvas || a.duration !== undefined) cur = ops.setSceneProps(doc, { name: a.name, canvas: a.canvas, duration: a.duration });
      if (cur.ok && a.camera) cur = ops.setCamera(cur.scene, a.camera);
      if (cur.ok && audio) cur = ops.setAudio(cur.scene, audio);
      return cur;
    });
    return { summary: `Scene ${a.sceneId} updated`, warnings: r.warnings, scene: ws.sceneView(a.sceneId) };
  },
});

def({
  name: "scene_delete",
  description: "Delete a scene. Assets and previously rendered artifacts are kept.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  mutates: true,
  handler: async (ctx, a) => {
    ctx.workspace(a.workspaceId).deleteScene(a.sceneId);
    return { summary: `Scene ${a.sceneId} deleted`, deleted: a.sceneId };
  },
});

// ---------------------------------------------------------------------------------------------
// layers

def({
  name: "layer_add",
  description:
    "Add one or more layers atomically (a child may come before its parent in the same call). A layer shows an asset (asset: assetId), a fill rectangle, or nothing (group/transform node). x/y place the layer's PIVOT; anchorX/Y choose the pivot inside the box; parent gives transform inheritance only; z alone sets the GLOBAL draw order (a child can draw above unrelated layers that cover its parent). width/height default to the asset's pixel size.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      layers: z.array(LayerSchema).min(1).max(500).describe("Layers to add, in order (order only breaks z ties)."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const ws = require2D(ctx.workspace(a.workspaceId), a.sceneId);
    const layers = (raw?.layers ?? a.layers) as Record<string, unknown>[];
    const r = await ws.mutateScene(a.sceneId, (doc) => ops.addLayers(doc, layers));
    return { summary: `Added ${layers.length} layer(s) to ${a.sceneId}`, added: layers.map((l) => l.id), warnings: r.warnings };
  },
});

def({
  name: "layer_update",
  description:
    "Change several properties of one layer ({layerId, patch}) or of many layers ({updates:[{layerId, patch}]}) in ONE atomic step; if anything is invalid nothing changes. Patch keys are layer fields (x, y, width, height, scaleX, scaleY, anchorX, anchorY, rotation, opacity, visible, z, parent, parentPoint, asset, fill, mask, attachmentPoints). null removes a field. Static values are overridden by animation tracks on the same property.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      layerId: IdSchema.optional().describe("Single-layer form: the layer to change."),
      patch: LayerPatchSchema.optional(),
      updates: z.array(z.object({ layerId: IdSchema, patch: LayerPatchSchema }).strict()).max(500).optional().describe("Multi-layer form."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const updates: { layerId: string; patch: Record<string, unknown> }[] = raw?.updates ?? (raw?.layerId ? [{ layerId: raw.layerId, patch: raw.patch ?? {} }] : []);
    if (!updates.length) throw new EngineError("INVALID_ARGUMENT", "Give either {layerId, patch} or {updates:[{layerId, patch}]}");
    const ws = require2D(ctx.workspace(a.workspaceId), a.sceneId);
    const r = await ws.mutateScene(a.sceneId, (doc) => {
      let cur: ops.OpResult = { ok: true, scene: doc, warnings: [] };
      for (const [i, u] of updates.entries()) {
        cur = ops.updateLayer(cur.scene, u.layerId, u.patch);
        if (!cur.ok) return { ok: false, errors: cur.errors.map((e) => ({ ...e, details: { ...e.details, layerId: u.layerId, updateIndex: i } })) };
      }
      return cur;
    });
    const doc = ws.getSceneDoc(a.sceneId);
    const changed = updates.map((u) => doc.layers.find((l: any) => l.id === u.layerId));
    return { summary: `Updated ${updates.length} layer(s) in ${a.sceneId}`, layers: changed, warnings: r.warnings };
  },
});

def({
  name: "layer_remove",
  description: "Remove a layer and its animation tracks. If it has children: children='error' (default) refuses, 'cascade' removes descendants too, 'reparent' moves them to the removed layer's parent.",
  args: z
    .object({ workspaceId: WorkspaceId, sceneId: SceneId, layerId: IdSchema, children: z.enum(["error", "cascade", "reparent"]).optional() })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const r = await require2D(ctx.workspace(a.workspaceId), a.sceneId).mutateScene(a.sceneId, (doc) => ops.removeLayer(doc, { id: a.layerId, children: a.children }));
    return { summary: `Removed ${(r.result as any)?.removed?.join(", ")}`, removed: (r.result as any)?.removed };
  },
});

def({
  name: "layer_list",
  description: "All layers of a scene with their static properties, parent and z, plus which properties are animated.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  handler: async (ctx, a) => {
    const doc = require2D(ctx.workspace(a.workspaceId), a.sceneId).getSceneDoc(a.sceneId);
    const layers = layerSummary(doc);
    return { summary: `${layers.length} layer(s)`, layers };
  },
});

// ---------------------------------------------------------------------------------------------
// timeline

def({
  name: "timeline_get",
  description: "Animation tracks of a scene (optionally one target: a layer id or 'camera'). Each track = {target, property, keyframes:[{frame, value, interpolation}]}.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId, target: z.string().optional() }).strict(),
  handler: async (ctx, a) => {
    const doc = ctx.workspace(a.workspaceId).getSceneDoc(a.sceneId);
    const tracks = (doc.animations ?? []).filter((t: any) => !a.target || t.target === a.target);
    return { summary: `${tracks.length} track(s)`, duration: doc.duration, fps: doc.canvas.fps, tracks };
  },
});

def({
  name: "timeline_apply",
  description:
    "Apply a batch of animation operations atomically (all or nothing; errors name the failing operations[i]). Types: keyframe.add {target, property, frame, value, interpolation?} (replaces a key at the same frame), keyframe.update {target, property, frame, patch}, keyframe.remove, track.set {target, property, keyframes}, track.remove. 2D: target = layer id or 'camera' (x, y, scale, rotation). 3D: target = object/light id, 'camera' (position.x/y/z, rotation.x/y/z, lookAt.x/y/z, fov) or 'world' (strength, color); object properties position.*, rotation.*, scale.*, visible, clip (step: switches animation clip, crossfaded), morph.<name> (0..1). A keyframe's interpolation shapes the segment to the NEXT keyframe; values hold before the first and after the last key. Discrete properties (asset, visible, z, fill, clip, color) must use step.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      operations: z.array(ops.TimelineOpSchema).min(1).max(2000),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const r = await ctx.workspace(a.workspaceId).mutateScene(a.sceneId, (doc) => ops.applyTimelineOps(doc, raw?.operations ?? a.operations));
    return { summary: `Applied ${a.operations.length} timeline operation(s) to ${a.sceneId}`, applied: a.operations.length, warnings: r.warnings };
  },
});

// ---------------------------------------------------------------------------------------------
// layout & rendering

def({
  name: "measure_layout",
  description:
    "Numeric geometry at a frame after animation, parenting and camera. 2D: per layer worldPivot, worldCenter, worldBounds, worldRotation, screenBounds, onScreen, z, drawIndex, visible/opacity, attachment points. 3D: per object world position/rotation/scale (metres/degrees), world bounds, screen bounds in pixels (onScreen, fullyOnScreen, visibleFraction), cameraSpace depth, active clips (name/time/weight), asset, and bone/socket positions (world + screen) for rigged models; plus camera and lights. Use it to check and correct placement numerically.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      frame: FrameArg,
      layers: z.array(IdSchema).optional().describe("Only these layers / 3D objects (default all)."),
      bones: z.array(z.string()).max(50).optional().describe("3D: extra joints or sockets to report on rigged models (default: hands, head, root, hips)."),
      detail: z.enum(["compact", "full"]).optional().describe("full adds corners, matrices and local values (2D) / every detected socket (3D)."),
    })
    .strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    if (ws.sceneKind(a.sceneId) === "3d") {
      const m = await ws.measure3D(a.sceneId, a.frame, { objects: a.layers, bones: a.bones });
      return { summary: `3D layout of ${a.sceneId} at frame ${a.frame} (${m.objects.length} objects)`, ...compactMeasure3D(m, a.detail ?? "compact", a.bones ?? []) };
    }
    const layout = await ctx.workspace(a.workspaceId).measureLayout(a.sceneId, a.frame, a.layers);
    return { summary: `Layout of ${a.sceneId} at frame ${a.frame} (${layout.layers.length} layers)`, ...compactLayout(layout, a.detail ?? "compact") };
  },
});

def({
  name: "render_preview",
  description:
    "Render one frame to a PNG artifact with the real engine. debug=true overlays layer bounds, ids, z, parents, pivots, centres and attachment points (debugOptions.only limits it to some layers). Returns artifactId, relativePath and viewPath: a small JPEG you can open with your image/file viewer to LOOK at the result.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      frame: FrameArg,
      debug: z.boolean().optional().describe("2D: bounds/ids/z/pivots overlay. 3D: screen boxes, ids, clips, depth, hand/head/root sockets."),
      quality: Render3DSchema.shape.quality.unwrap().optional().describe("3D only: preview quality (default draft; video uses the scene's render.quality)."),
      debugOptions: z
        .object({
          only: z.array(IdSchema).optional(),
          bounds: z.boolean().optional(),
          aabb: z.boolean().optional(),
          labels: z.boolean().optional(),
          pivots: z.boolean().optional(),
          centers: z.boolean().optional(),
          attachmentPoints: z.boolean().optional(),
          includeHidden: z.boolean().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = (await ws.renderPreview(a.sceneId, a.frame, { debug: a.debug, debugOptions: a.debugOptions, quality: a.quality })) as ArtifactRecord & { measurement?: Measurement3D };
    const { measurement, ...art } = r;
    return {
      summary: `${a.debug ? "Debug preview" : "Preview"} ${art.artifactId}: ${a.sceneId} frame ${a.frame}`,
      artifact: presentArtifact(ws, art),
      viewPath: ws.abs(art.view!.relativePath),
      ...(measurement ? { layout3d: compactMeasure3D(measurement, "compact", []) } : {}),
    };
  },
});

def({
  name: "render_frame",
  description: "Render one frame through the exact deterministic path used for video (PNG artifact + pixel SHA-256 for comparisons). Returns artifactId, relativePath and viewPath.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId, frame: FrameArg }).strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const art = await ws.renderFrame(a.sceneId, a.frame);
    return { summary: `Frame ${art.artifactId}: ${a.sceneId} frame ${a.frame}`, artifact: presentArtifact(ws, art), viewPath: ws.abs(art.view!.relativePath) };
  },
});

function presentJob(ws: VideoWorkspace, j: ReturnType<RenderJobs["get"]>) {
  return {
    renderId: j.renderId,
    sceneId: j.sceneId,
    status: j.status,
    frame: j.frame,
    totalFrames: j.totalFrames,
    progress: j.progress,
    ...(j.elapsedSeconds !== undefined ? { elapsedSeconds: j.elapsedSeconds } : {}),
    ...(j.artifact ? { artifact: presentArtifact(ws, j.artifact), artifactId: j.artifact.artifactId, relativePath: j.artifact.relativePath, durationSeconds: j.artifact.durationSeconds } : {}),
    ...(j.error ? { error: j.error } : {}),
  };
}

def({
  name: "render_video_start",
  description:
    "Start rendering a scene (or a frame range) to an H.264 MP4 with its audio. Returns immediately with a renderId; follow with render_video_status (use waitSeconds to wait for completion) and render_video_cancel.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      startFrame: z.number().int().min(0).optional(),
      endFrame: z.number().int().min(1).optional().describe("Exclusive; default = scene duration."),
      crf: z.number().int().min(0).max(51).optional().describe("x264 quality, lower = better (default 18)."),
      audio: z.boolean().optional().describe("Include scene audio (default true)."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const j = await ctx.jobsFor(ws).start(a.sceneId, { startFrame: a.startFrame, endFrame: a.endFrame, crf: a.crf, audio: a.audio });
    return { summary: `Render ${j.renderId} started (${j.totalFrames} frames)`, ...presentJob(ws, j) };
  },
});

def({
  name: "render_video_status",
  description: "Status of a video render: queued | running | completed | failed | cancelled | interrupted, with frame/totalFrames/progress. waitSeconds (max 45) waits for completion first. When completed: artifactId, relativePath, path, durationSeconds and a poster viewPath.",
  args: z
    .object({ workspaceId: WorkspaceId, renderId: IdSchema, waitSeconds: z.number().min(0).max(45).optional().describe("Wait up to this long for the render to finish.") })
    .strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const j = await ctx.jobsFor(ws).wait(a.renderId, (a.waitSeconds ?? 0) * 1000);
    return { summary: `Render ${j.renderId}: ${j.status} (${Math.round(j.progress * 100)}%)`, ...presentJob(ws, j) };
  },
});

def({
  name: "render_video_cancel",
  description: "Cancel a queued or running video render (the partial file is deleted). No effect on finished renders.",
  args: z.object({ workspaceId: WorkspaceId, renderId: IdSchema }).strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const j = ctx.jobsFor(ws).cancel(a.renderId);
    return { summary: `Render ${a.renderId}: cancel requested (${j.status})`, ...presentJob(ws, j) };
  },
});

def({
  name: "artifact_list",
  description: "List rendered artifacts (preview, debug-preview, frame, video) with their ids, frames and relative paths.",
  args: z.object({ workspaceId: WorkspaceId, kind: z.enum(["preview", "debug-preview", "frame", "video"]).optional(), sceneId: IdSchema.optional() }).strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const list = ws.listArtifacts(a).map((x) => presentArtifact(ws, x));
    return { summary: `${list.length} artifact(s)`, artifacts: list };
  },
});

// ---------------------------------------------------------------------------------------------
// 3D

function require2D(ws: VideoWorkspace, sceneId: string) {
  if (ws.sceneKind(sceneId) === "3d") throw new EngineError("INVALID_ARGUMENT", `Scene "${sceneId}" is a 3D scene: use object_add / object_update / object_remove / object_list`, { sceneId, kind: "3d" });
  return ws;
}

function require3D(ws: VideoWorkspace, sceneId: string) {
  if (ws.sceneKind(sceneId) !== "3d") throw new EngineError("INVALID_ARGUMENT", `Scene "${sceneId}" is a 2D scene: use the layer_* tools (or create a scene with kind:'3d')`, { sceneId, kind: "2d" });
  return ws;
}

function modelSummary(m: NonNullable<ReturnType<VideoWorkspace["getAsset"]>["model"]>) {
  return {
    format: m.format,
    rigged: m.rigged,
    clips: m.clips.map((c) => ({ name: c.name, seconds: r2(c.duration) })),
    sockets: m.sockets,
    joints: m.joints.length,
    morphTargets: m.morphTargets,
    boundsMetres: m.bounds ? { size: m.bounds.size.map(r2), min: m.bounds.min.map(r2), max: m.bounds.max.map(r2) } : null,
    meshes: m.meshes.length,
    vertices: m.vertices,
  };
}

const KEY_SOCKETS = ["rightHand", "leftHand", "head", "root", "hips"];

function compactMeasure3D(m: Measurement3D, detail: "compact" | "full", extraBones: string[]) {
  if (detail === "full") return m;
  const keep = new Set([...KEY_SOCKETS, ...extraBones]);
  return {
    ...m,
    objects: m.objects.map((o: any) => ({
      ...o,
      ...(o.bones ? { bones: Object.fromEntries(Object.entries(o.bones).filter(([k]) => keep.has(k))) } : {}),
    })),
  };
}

const vecPatch = Vec3Schema.partial().describe("Metres / degrees / factors per axis; omitted axes keep their value.");
const Entity3DPatch = z
  .object({
    asset: IdSchema.nullable().optional(),
    primitive: PrimitiveSchema.nullable().optional(),
    parent: IdSchema.nullable().optional(),
    attach: AttachSchema.nullable().optional(),
    position: vecPatch.nullable().optional(),
    rotation: vecPatch.nullable().optional(),
    scale: vecPatch.nullable().optional(),
    visible: z.boolean().nullable().optional(),
    clip: z.string().nullable().optional(),
    clipSpeed: z.number().nullable().optional(),
    clipLoop: z.boolean().nullable().optional(),
    clipOffset: z.number().nullable().optional(),
    clipBlend: z.number().int().nullable().optional(),
    morphs: z.record(z.string(), z.number()).nullable().optional().describe("Merged into the current morph weights."),
    meta: z.record(z.string(), z.unknown()).nullable().optional(),
    type: Light3DSchema.shape.type.nullable().optional(),
    color: ColorSchema.nullable().optional(),
    intensity: z.number().nullable().optional(),
    size: z.number().nullable().optional(),
    spotAngle: z.number().nullable().optional(),
    shadows: z.boolean().nullable().optional(),
  })
  .strict()
  .describe("Fields to change (object or light fields). null removes a field (default; parent/attach/clip: detach/none).");

def({
  name: "object_add",
  description:
    "3D scenes: add objects and/or lights atomically (an attachment or child may precede its target). Object = model asset (asset: assetId of a .glb), primitive {shape: plane|box|sphere|cylinder, size, color}, or empty group. position/rotation/scale are glTF-style metres/degrees (+y up, models face +z). clip plays an animation clip (see asset_inspect). attach {object, bone: socket like rightHand/head or a joint name} makes the object follow that bone through animation (position/rotation become offsets). morphs sets face shapes. Lights: sun (direction only: rotation), point, spot, area; lights shine along their -z.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      objects: z.array(Object3DSchema).max(200).optional(),
      lights: z.array(Light3DSchema).max(50).optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const ws = require3D(ctx.workspace(a.workspaceId), a.sceneId);
    const objects = (raw?.objects ?? a.objects ?? []) as Record<string, unknown>[];
    const lights = (raw?.lights ?? a.lights ?? []) as Record<string, unknown>[];
    if (!objects.length && !lights.length) throw new EngineError("INVALID_ARGUMENT", "Give objects and/or lights");
    const r = await ws.mutateScene(a.sceneId, (doc) => ops3d.addEntities3D(doc, { objects, lights }));
    const models = Object.fromEntries(
      [...new Set(objects.map((o) => o.asset).filter((x): x is string => typeof x === "string"))].map((id) => {
        const m = ws.getAsset(id).model!;
        return [id, { clips: m.clips.map((c) => c.name), sockets: Object.keys(m.sockets), morphTargets: m.morphTargets }];
      }),
    );
    return { summary: `Added ${[...objects, ...lights].map((o) => o.id).join(", ")} to ${a.sceneId}`, added: (r.result as any)?.added, models, warnings: r.warnings };
  },
});

def({
  name: "object_update",
  description:
    "3D scenes: change one object/light ({id, patch}) or many ({updates:[{id, patch}]}) in ONE atomic step. Vectors merge per axis ({position:{y:1}} keeps x and z). null removes a field (restores its default; parent/attach null detaches, clip null stops the clip). Static values are overridden by timeline tracks on the same property.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      id: IdSchema.optional().describe("Single form: object or light id."),
      patch: Entity3DPatch.optional(),
      updates: z.array(z.object({ id: IdSchema, patch: Entity3DPatch }).strict()).max(200).optional().describe("Multi form."),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const updates: { id: string; patch: Record<string, unknown> }[] = raw?.updates ?? (raw?.id ? [{ id: raw.id, patch: raw.patch ?? {} }] : []);
    if (!updates.length) throw new EngineError("INVALID_ARGUMENT", "Give either {id, patch} or {updates:[{id, patch}]}");
    const ws = require3D(ctx.workspace(a.workspaceId), a.sceneId);
    const r = await ws.mutateScene(a.sceneId, (doc) => {
      let cur: ops.OpResult<unknown> = { ok: true, scene: doc, warnings: [] };
      for (const [i, u] of updates.entries()) {
        cur = ops3d.updateEntity3D(cur.scene, u.id, u.patch);
        if (!cur.ok) return { ok: false, errors: cur.errors.map((e) => ({ ...e, details: { ...e.details, id: u.id, updateIndex: i } })) };
      }
      return cur;
    });
    const doc = ws.getSceneDoc(a.sceneId);
    const all = [...doc.objects, ...doc.lights];
    return { summary: `Updated ${updates.map((u) => u.id).join(", ")} in ${a.sceneId}`, updated: updates.map((u) => all.find((o: any) => o.id === u.id)), warnings: r.warnings };
  },
});

def({
  name: "object_remove",
  description: "3D scenes: remove an object or light and its animation tracks. Objects parented or attached to it: children='error' (default) refuses, 'cascade' removes them too, 'detach' keeps them at the scene root.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId, id: IdSchema, children: z.enum(["error", "cascade", "detach"]).optional() }).strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = require3D(ctx.workspace(a.workspaceId), a.sceneId);
    const r = await ws.mutateScene(a.sceneId, (doc) => ops3d.removeEntity3D(doc, a.id, a.children));
    return { summary: `Removed ${(r.result as any)?.removed?.join(", ")}`, removed: (r.result as any)?.removed };
  },
});

def({
  name: "object_list",
  description: "3D scenes: objects and lights with their static fields, which properties are animated, and for model objects the clips, sockets and morph targets of their asset. Also camera, world, render settings and overlay.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  handler: async (ctx, a) => {
    const ws = require3D(ctx.workspace(a.workspaceId), a.sceneId);
    const doc = ws.getSceneDoc(a.sceneId);
    const animated = (id: string) => (doc.animations ?? []).filter((t: any) => t.target === id).map((t: any) => t.property);
    const objects = (doc.objects ?? []).map((o: any) => {
      const m = o.asset && ws.hasAsset(o.asset) ? ws.getAsset(o.asset).model : undefined;
      return { ...o, animated: animated(o.id), ...(m ? { model: { clips: m.clips.map((c) => c.name), sockets: Object.keys(m.sockets), morphTargets: m.morphTargets } } : {}) };
    });
    const lights = (doc.lights ?? []).map((l: any) => ({ ...l, animated: animated(l.id) }));
    return {
      summary: `${objects.length} object(s), ${lights.length} light(s)`,
      objects,
      lights,
      camera: { ...doc.camera, animated: animated("camera") },
      world: { ...doc.world, animated: animated("world") },
      render: doc.render,
      overlay: doc.overlay ?? null,
    };
  },
});

def({
  name: "scene_settings_3d",
  description:
    "3D scenes: set the camera {position, rotation, lookAt: {x,y,z} | {object, bone?} | null, fov (vertical degrees), near, far}, world {color, strength} (ambient light/background), render {quality: draft|standard|high, transparentBackground, engine?, samples?} and overlay {scene: <2D scene id>} | null (2D scene composited over every frame: titles, captions; give it a transparent background #00000000 and the same canvas). Vectors merge per axis; null resets a field. Animate the camera with timeline_apply target 'camera'.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      camera: z
        .object({
          position: vecPatch.optional(),
          rotation: vecPatch.optional(),
          lookAt: Camera3DSchema.shape.lookAt,
          fov: Camera3DSchema.shape.fov.unwrap().nullable().optional(),
          near: Camera3DSchema.shape.near.unwrap().nullable().optional(),
          far: Camera3DSchema.shape.far.unwrap().nullable().optional(),
        })
        .strict()
        .optional(),
      world: z.object({ color: ColorSchema.nullable().optional(), strength: World3DSchema.shape.strength.unwrap().nullable().optional() }).strict().optional(),
      render: z
        .object({
          quality: Render3DSchema.shape.quality.unwrap().nullable().optional(),
          engine: Render3DSchema.shape.engine.nullable(),
          samples: Render3DSchema.shape.samples.nullable(),
          transparentBackground: z.boolean().nullable().optional(),
        })
        .strict()
        .optional(),
      overlay: z.object({ scene: IdSchema }).strict().nullable().optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a, raw?: any) => {
    const ws = require3D(ctx.workspace(a.workspaceId), a.sceneId);
    await ws.mutateScene(a.sceneId, (doc) => ops3d.setSettings3D(doc, { camera: raw?.camera, world: raw?.world, render: raw?.render, overlay: raw?.overlay }));
    const doc = ws.getSceneDoc(a.sceneId);
    return { summary: `3D settings of ${a.sceneId} updated`, camera: doc.camera, world: doc.world, render: doc.render, overlay: doc.overlay ?? null };
  },
});

export const TOOL_DEFS: readonly ToolDef[] = tools;
