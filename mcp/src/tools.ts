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
    } catch (e) {
      checks.endToEndRender = { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const ok = Object.values(checks).every((c) => c.ok);
  return { summary: ok ? "healthy" : "UNHEALTHY", ok, checks, node: process.version, platform: `${process.platform}-${process.arch}` };
}

def({
  name: "engine_health",
  description: "Check that FFmpeg, the Skia renderer, image I/O and the workspace root work. deep=true also renders and encodes a tiny test video (a few seconds).",
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
  description: "List read-only asset libraries configured on this server, or the image/audio files inside one (paths are relative to the library; import them with asset_import).",
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
    "Add an image (png/jpg/webp) or audio file (wav/mp3/...) to the workspace as an asset with a stable id. Source is exactly one of: {library, path} (read-only library file), {inbox: '<relative path in the workspace inbox>'}, or {base64, filename} (small files). Importing identical content again returns the existing asset (reused=true). Scenes reference assets by id, so one asset can be used by many layers/scenes without copies.",
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
    return { summary: `${r.reused ? "Reused existing" : "Imported"} asset ${r.asset.assetId}`, reused: r.reused, asset: r.asset };
  },
});

def({
  name: "asset_list",
  description: "List assets in a workspace (id, kind, size, alpha, tags, provenance operation).",
  args: z.object({ workspaceId: WorkspaceId, kind: z.enum(["image", "audio"]).optional(), tag: z.string().optional() }).strict(),
  handler: async (ctx, a) => {
    const list = ctx.workspace(a.workspaceId).listAssets(a);
    return {
      summary: `${list.length} asset(s)`,
      assets: list.map((x) => ({
        assetId: x.assetId, name: x.name, kind: x.kind, width: x.width, height: x.height, hasAlpha: x.hasAlpha, tags: x.tags,
        operation: x.provenance.operation, ...(x.provenance.sourceAssetId ? { sourceAssetId: x.provenance.sourceAssetId } : {}),
        ...(x.attachmentPoints ? { attachmentPoints: x.attachmentPoints } : {}),
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
    "Analyse an image asset without changing it: size, alpha statistics, border background colour/uniformity, visible bounds and suggestedPath ('native-alpha' = already transparent -> asset_trim; 'color-key' = solid background -> asset_process; 'opaque' = full-frame plate, use as is). Returns viewPath: a small JPEG (checkerboard = transparency) to look at.",
  args: z.object({ workspaceId: WorkspaceId, assetId: AssetId }).strict(),
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.inspectAsset(a.assetId);
    return {
      summary: `Asset ${a.assetId}: ${r.inspection ? r.inspection.suggestedPath : r.asset.kind}`,
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
    "Create an empty scene (a structured engine scene document). Coordinates are canvas pixels, origin top-left, +y down, rotation in degrees clockwise. Frames run 0..duration-1. Add layers with layer_add and animation with timeline_apply.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: IdSchema.optional().describe("Optional id (default scene_N)."),
      name: z.string().max(200).optional(),
      canvas: CanvasPatch.optional(),
      duration: z.number().int().min(1).max(216000).optional().describe("Length in frames (default 5 seconds)."),
      camera: CameraPatch.optional(),
    })
    .strict(),
  mutates: true,
  handler: async (ctx, a) => {
    const ws = ctx.workspace(a.workspaceId);
    const r = await ws.createScene(a);
    const doc = ws.getSceneDoc(r.sceneId);
    return { summary: `Scene ${r.sceneId} created (${doc.canvas.width}x${doc.canvas.height}, ${doc.duration} frames @ ${doc.canvas.fps} fps)`, sceneId: r.sceneId, canvas: doc.canvas, duration: doc.duration, warnings: r.warnings };
  },
});

def({
  name: "scene_get",
  description: "The full scene: canvas, duration, camera, layers (engine fields), animation tracks, audio (by assetId) and assetsUsed. Layers reference assets by id in their `asset` field.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  handler: async (ctx, a) => {
    const v = ctx.workspace(a.workspaceId).sceneView(a.sceneId);
    return { summary: `Scene ${a.sceneId}: ${(v as any).layers?.length ?? 0} layers, ${(v as any).animations?.length ?? 0} tracks`, scene: v };
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
    const ws = ctx.workspace(a.workspaceId);
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
    const ws = ctx.workspace(a.workspaceId);
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
    const r = await ctx.workspace(a.workspaceId).mutateScene(a.sceneId, (doc) => ops.removeLayer(doc, { id: a.layerId, children: a.children }));
    return { summary: `Removed ${(r.result as any)?.removed?.join(", ")}`, removed: (r.result as any)?.removed };
  },
});

def({
  name: "layer_list",
  description: "All layers of a scene with their static properties, parent and z, plus which properties are animated.",
  args: z.object({ workspaceId: WorkspaceId, sceneId: SceneId }).strict(),
  handler: async (ctx, a) => {
    const doc = ctx.workspace(a.workspaceId).getSceneDoc(a.sceneId);
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
    "Apply a batch of animation operations atomically (all or nothing; errors name the failing operations[i]). Types: keyframe.add {target, property, frame, value, interpolation?} (replaces a key at the same frame), keyframe.update {target, property, frame, patch}, keyframe.remove, track.set {target, property, keyframes}, track.remove. target = layer id or 'camera'. A keyframe's interpolation shapes the segment to the NEXT keyframe; values hold before the first and after the last key. Discrete properties (asset, visible, z, fill) must use step. Camera properties: x, y, scale, rotation.",
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
    "Numeric geometry at a frame after animation, parenting and camera: per layer worldPivot, worldCenter, worldBounds (axis-aligned box), worldRotation, screenBounds (after camera), onScreen, z, drawIndex (position in final draw order), visible/opacity, and attachment points in world+screen coordinates. Use it to check and correct placement numerically.",
  args: z
    .object({
      workspaceId: WorkspaceId,
      sceneId: SceneId,
      frame: FrameArg,
      layers: z.array(IdSchema).optional().describe("Only these layers (default all)."),
      detail: z.enum(["compact", "full"]).optional().describe("full adds corners, matrices and local values."),
    })
    .strict(),
  handler: async (ctx, a) => {
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
      debug: z.boolean().optional(),
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
    const art = await ws.renderPreview(a.sceneId, a.frame, { debug: a.debug, debugOptions: a.debugOptions });
    return { summary: `${a.debug ? "Debug preview" : "Preview"} ${art.artifactId}: ${a.sceneId} frame ${a.frame}`, artifact: presentArtifact(ws, art), viewPath: ws.abs(art.view!.relativePath) };
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

export const TOOL_DEFS: readonly ToolDef[] = tools;
