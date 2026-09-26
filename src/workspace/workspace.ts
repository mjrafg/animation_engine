/**
 * Video workspaces: the persistent, ID-based production area the engine works in.
 *
 *   <root>/<workspaceId>/
 *     workspace.json            id, name, createdAt, id counters
 *     inbox/                    files dropped here can be imported as assets (relative paths only)
 *     assets/<assetId>/         asset.json + the asset file (+ processing byproducts, view.jpg)
 *     scenes/<sceneId>.json     engine scene documents (validated on every write)
 *     previews/ frames/ renders/  rendered artifacts; artifacts/<artifactId>.json describes each
 *     jobs/<renderId>.json      render job state
 *
 * Everything is addressed by stable ids (workspaceId, assetId, sceneId, artifactId, renderId).
 * Scenes reference assets by id; the same asset can back any number of layers and scenes without
 * copying. Asset processing never modifies an asset: it creates a new derived asset that records
 * its provenance.
 *
 * This module is part of the core engine; the MCP server is only a thin adapter over it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import * as ops from "../api/operations.js";
import { AnimationEngine } from "../api/engine.js";
import { findComponents, removeComponents } from "../assets/components.js";
import { readRgba, writePng } from "../assets/image.js";
import { inspectImage, processAsset, type ProcessOptions } from "../assets/pipeline.js";
import { trimTransparent, type TrimOptions } from "../assets/trim.js";
import type { DebugOptions } from "../engine/debugOverlay.js";
import type { FrameLayout } from "../engine/layout.js";
import { EngineError, errorFromIssues } from "../errors.js";
import { validateScene, type ValidationIssue } from "../scene/validate.js";
import { startEncoder } from "../render/video.js";
import { inspectGltf, type ModelInfo } from "../scene3d/gltf.js";
import * as ops3d from "../scene3d/operations.js";
import { measure3D, modelThumbnail, renderFrames3D, type Measure3DOptions, type Scene3DContext } from "../scene3d/render.js";
import type { Scene3D } from "../scene3d/schema.js";
import { validateScene3D, type AssetLookup3D } from "../scene3d/validate.js";
import { describeCharacter } from "../characters/capabilities.js";
import { analyzeJoints2D, type AlphaImage } from "../characters/continuity.js";
import type { CharacterContext } from "../characters/operations.js";
import { CharacterDefinitionSchema, SpeechTimingSchema, type CharacterDefinition, type SpeechTiming } from "../characters/schema.js";
import { checkEntityId, checkWorkspaceId, readJson, resolveInside, toPosix, writeFileAtomic } from "./paths.js";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
export const MODEL_EXT = new Set([".glb", ".gltf"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
};

export interface AssetRecord {
  assetId: string;
  name: string;
  kind: "image" | "audio" | "model";
  /** Workspace-relative path of the asset file. */
  file: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  /** 3D model facts (kind "model"): clips, skeleton, sockets, morph targets, bounds. */
  model?: ModelInfo;
  tags: string[];
  /** Named points in normalised asset-box coordinates (0,0 top-left .. 1,1 bottom-right). */
  attachmentPoints?: Record<string, { x: number; y: number }>;
  createdAt: string;
  /** How this asset came to exist. Derived assets name their source asset. */
  provenance: {
    operation: "import" | "process" | "trim" | "component_remove";
    source?: Record<string, unknown>;
    sourceAssetId?: string;
    options?: unknown;
    diagnostics?: unknown;
  };
  /** Extra files produced with the asset (e.g. background-mask), workspace-relative. */
  auxFiles?: Record<string, string>;
}

export type ArtifactKind = "preview" | "debug-preview" | "frame" | "video";

export interface ArtifactRecord {
  artifactId: string;
  kind: ArtifactKind;
  sceneId: string;
  frame?: number;
  startFrame?: number;
  endFrame?: number;
  width: number;
  height: number;
  durationSeconds?: number;
  relativePath: string;
  bytes: number;
  /** Small JPEG copy for looking at the result (<= ~140 KB, <= 960 px wide). */
  view?: { relativePath: string; width: number; height: number; bytes: number };
  renderId?: string;
  createdAt: string;
}

interface WorkspaceMeta {
  id: string;
  name: string;
  createdAt: string;
  version: 1;
  counters: Record<string, number>;
}

const now = () => new Date().toISOString();
const slug = (s: string) =>
  s
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^[^A-Za-z_]+/, "")
    .slice(0, 48) || "asset";

export function mimeOf(file: string): string | undefined {
  return MIME[path.extname(file).toLowerCase()];
}

// ---------------------------------------------------------------------------------------------

/** Downscaled JPEG for inspection; transparent images are shown over a checkerboard. */
export async function makeViewImage(input: string | Buffer, out: string, opts: { maxWidth?: number; maxBytes?: number } = {}) {
  const maxBytes = opts.maxBytes ?? 140_000;
  let width = opts.maxWidth ?? 960;
  const meta = await sharp(input).metadata();
  let base = sharp(input);
  if (meta.hasAlpha) {
    const w = meta.width!;
    const h = meta.height!;
    const cell = Math.max(8, Math.round(Math.max(w, h) / 48));
    const px = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? 205 : 245;
        const i = (y * w + x) * 3;
        px[i] = px[i + 1] = px[i + 2] = v;
      }
    }
    const flat = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
      .composite([{ input: await sharp(input).png().toBuffer() }])
      .png()
      .toBuffer();
    base = sharp(flat);
  }
  const src = await base.png().toBuffer();
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const quality of [82, 72, 62, 52]) {
      const buf = await sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (buf.length <= maxBytes || (quality === 52 && width <= 320)) {
        writeFileAtomic(out, buf);
        const m = await sharp(buf).metadata();
        return { width: m.width!, height: m.height!, bytes: buf.length };
      }
    }
    width = Math.round(width * 0.8);
  }
  throw new EngineError("INTERNAL_ERROR", "Could not produce a small view image");
}

// ---------------------------------------------------------------------------------------------

export interface WorkspaceManagerOptions {
  /** Directory that contains all workspaces. */
  root: string;
  /** If set, only this workspace may be created/opened (per-deployment assignment). */
  lockedWorkspace?: string;
  /** Read-only asset libraries the operator exposes: name -> directory. */
  libraries?: Record<string, string>;
}

export class WorkspaceManager {
  readonly root: string;
  private cache = new Map<string, VideoWorkspace>();
  constructor(private opts: WorkspaceManagerOptions) {
    this.root = path.resolve(opts.root);
    fs.mkdirSync(this.root, { recursive: true });
    if (opts.lockedWorkspace) checkWorkspaceId(opts.lockedWorkspace);
  }

  get lockedWorkspace() {
    return this.opts.lockedWorkspace;
  }

  private checkAllowed(id: string) {
    checkWorkspaceId(id);
    if (this.opts.lockedWorkspace && id !== this.opts.lockedWorkspace) {
      throw new EngineError("WORKSPACE_FORBIDDEN", `This server is assigned to workspace "${this.opts.lockedWorkspace}" only`, {
        workspaceId: id,
        assignedWorkspace: this.opts.lockedWorkspace,
      });
    }
  }

  list(): { workspaceId: string; name: string; createdAt: string }[] {
    const ids = fs.readdirSync(this.root).filter((d) => fs.existsSync(path.join(this.root, d, "workspace.json")));
    return ids
      .filter((id) => !this.opts.lockedWorkspace || id === this.opts.lockedWorkspace)
      .sort()
      .map((id) => {
        const m = readJson<WorkspaceMeta>(path.join(this.root, id, "workspace.json"));
        return { workspaceId: id, name: m.name, createdAt: m.createdAt };
      });
  }

  exists(id: string) {
    return fs.existsSync(path.join(this.root, id, "workspace.json"));
  }

  create(id: string, opts: { name?: string } = {}): VideoWorkspace {
    this.checkAllowed(id);
    if (this.exists(id)) throw new EngineError("WORKSPACE_EXISTS", `Workspace "${id}" already exists`, { workspaceId: id });
    const dir = path.join(this.root, id);
    for (const d of ["inbox", "assets", "scenes", "previews", "frames", "renders", "artifacts", "jobs"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const meta: WorkspaceMeta = { id, name: opts.name ?? id, createdAt: now(), version: 1, counters: {} };
    writeFileAtomic(path.join(dir, "workspace.json"), JSON.stringify(meta, null, 2));
    return this.open(id);
  }

  open(id: string, opts: { create?: boolean; name?: string } = {}): VideoWorkspace {
    this.checkAllowed(id);
    const cached = this.cache.get(id);
    if (cached && this.exists(id)) return cached;
    if (!this.exists(id)) {
      if (opts.create) return this.create(id, { name: opts.name });
      throw new EngineError("WORKSPACE_NOT_FOUND", `Workspace "${id}" does not exist`, {
        workspaceId: id,
        available: this.list().map((w) => w.workspaceId),
      });
    }
    const ws = new VideoWorkspace(id, path.join(this.root, id), this);
    this.cache.set(id, ws);
    return ws;
  }

  // ---- read-only libraries -------------------------------------------------------------------

  libraryNames(): string[] {
    return Object.keys(this.opts.libraries ?? {}).sort();
  }

  private libraryRoot(name: string): string {
    const dir = this.opts.libraries?.[name];
    if (!dir || !fs.existsSync(dir)) {
      throw new EngineError("LIBRARY_NOT_FOUND", `Unknown asset library "${name}"`, { library: name, available: this.libraryNames() });
    }
    return dir;
  }

  listLibrary(name: string, opts: { subdir?: string; limit?: number } = {}) {
    const root = this.libraryRoot(name);
    const start = opts.subdir ? resolveInside(root, opts.subdir) : fs.realpathSync(root);
    const out: { path: string; kind: "image" | "audio" | "model"; bytes: number }[] = [];
    const limit = opts.limit ?? 500;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else {
          const ext = path.extname(e.name).toLowerCase();
          const kind = IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : MODEL_EXT.has(ext) ? "model" : null;
          if (kind) out.push({ path: toPosix(path.relative(fs.realpathSync(root), full)), kind, bytes: fs.statSync(full).size });
        }
      }
    };
    walk(start);
    return out;
  }

  /** Character packages (directories with a character.json) inside a library. */
  listCharacterPackages(name: string) {
    const root = fs.realpathSync(this.libraryRoot(name));
    const out: { path: string; characterId: string; name: string; kind: string; description?: string }[] = [];
    const walk = (dir: string, depth: number) => {
      const f = path.join(dir, "character.json");
      if (fs.existsSync(f)) {
        try {
          const j = JSON.parse(fs.readFileSync(f, "utf8"));
          out.push({ path: toPosix(path.relative(root, dir)) || ".", characterId: j.id, name: j.name ?? j.id, kind: j.kind, ...(j.description ? { description: j.description } : {}) });
        } catch {
          /* not a valid package: skipped */
        }
        return;
      }
      if (depth <= 0) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory()) walk(path.join(dir, e.name), depth - 1);
    };
    walk(root, 3);
    return out;
  }

  /** Directory of a character package inside a library (must contain character.json). */
  resolveLibraryDir(name: string, rel: string): string {
    const dir = resolveInside(this.libraryRoot(name), rel || ".");
    if (!fs.existsSync(path.join(dir, "character.json"))) {
      throw new EngineError("CHARACTER_NOT_FOUND", `No character package (character.json) at "${rel}" in library "${name}"`, { library: name, path: rel, packages: this.listCharacterPackages(name).map((p) => p.path) });
    }
    return dir;
  }

  resolveLibraryFile(name: string, rel: string): string {
    const file = resolveInside(this.libraryRoot(name), rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new EngineError("FILE_NOT_FOUND", `No file "${rel}" in library "${name}"`, { library: name, path: rel });
    }
    return file;
  }
}

// ---------------------------------------------------------------------------------------------

export type ImportSource =
  | { kind: "file"; file: string; origin: Record<string, unknown> }
  | { kind: "bytes"; data: Buffer; filename: string; origin: Record<string, unknown> };

export class VideoWorkspace {
  private engines = new Map<string, { hash: string; engine: AnimationEngine }>();
  private sceneLocks = new Map<string, Promise<unknown>>();

  constructor(
    readonly id: string,
    readonly dir: string,
    readonly manager: WorkspaceManager,
  ) {}

  // ---- meta / ids --------------------------------------------------------------------------

  private metaFile() {
    return path.join(this.dir, "workspace.json");
  }

  meta(): WorkspaceMeta {
    return readJson<WorkspaceMeta>(this.metaFile());
  }

  /** Allocates the next sequential id for a kind: scene_1, preview_12, render_3 ... */
  nextId(kind: string): string {
    const m = this.meta();
    const n = (m.counters[kind] ?? 0) + 1;
    m.counters[kind] = n;
    writeFileAtomic(this.metaFile(), JSON.stringify(m, null, 2));
    return `${kind}_${n}`;
  }

  abs(rel: string): string {
    return resolveInside(this.dir, rel);
  }

  rel(abs: string): string {
    return toPosix(path.relative(this.dir, abs));
  }

  info() {
    const m = this.meta();
    return {
      workspaceId: this.id,
      name: m.name,
      createdAt: m.createdAt,
      assets: this.listAssets().length,
      scenes: this.listScenes().map((s) => s.sceneId),
      artifacts: this.listArtifacts().length,
      inbox: this.listInbox(),
      libraries: this.manager.libraryNames(),
    };
  }

  listInbox(): string[] {
    const inbox = path.join(this.dir, "inbox");
    if (!fs.existsSync(inbox)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out.push(toPosix(path.relative(inbox, full)));
      }
    };
    walk(inbox);
    return out.sort();
  }

  // ---- assets ------------------------------------------------------------------------------

  private assetDir(id: string) {
    return path.join(this.dir, "assets", id);
  }

  hasAsset(id: string) {
    return fs.existsSync(path.join(this.assetDir(id), "asset.json"));
  }

  getAsset(id: string): AssetRecord {
    checkEntityId("asset", id);
    if (!this.hasAsset(id)) {
      throw new EngineError("ASSET_NOT_FOUND", `Asset "${id}" does not exist in workspace "${this.id}"`, {
        assetId: id,
        available: this.listAssets().map((a) => a.assetId).slice(0, 50),
      });
    }
    return readJson<AssetRecord>(path.join(this.assetDir(id), "asset.json"));
  }

  listAssets(filter: { kind?: string; tag?: string } = {}): AssetRecord[] {
    const dir = path.join(this.dir, "assets");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((id) => fs.existsSync(path.join(dir, id, "asset.json")))
      .sort()
      .map((id) => readJson<AssetRecord>(path.join(dir, id, "asset.json")))
      .filter((a) => (!filter.kind || a.kind === filter.kind) && (!filter.tag || a.tags.includes(filter.tag)));
  }

  assetFile(id: string): string {
    return this.abs(this.getAsset(id).file);
  }

  private freshAssetId(requested: string | undefined, base: string): string {
    if (requested) {
      checkEntityId("asset", requested);
      if (this.hasAsset(requested)) throw new EngineError("ASSET_EXISTS", `Asset "${requested}" already exists`, { assetId: requested });
      return requested;
    }
    let id = slug(base);
    for (let i = 2; this.hasAsset(id); i++) id = `${slug(base)}_${i}`;
    return id;
  }

  private writeAsset(rec: AssetRecord) {
    writeFileAtomic(path.join(this.assetDir(rec.assetId), "asset.json"), JSON.stringify(rec, null, 2));
  }

  private async describeFile(file: string) {
    const bytes = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (IMAGE_EXT.has(ext)) {
      const m = await sharp(bytes).metadata().catch(() => null);
      if (!m?.width || !m?.height) throw new EngineError("INVALID_ASSET", `Not a readable image: ${path.basename(file)}`);
      return { kind: "image" as const, bytes: bytes.length, sha256: sha, width: m.width, height: m.height, hasAlpha: !!m.hasAlpha };
    }
    if (AUDIO_EXT.has(ext)) return { kind: "audio" as const, bytes: bytes.length, sha256: sha };
    if (MODEL_EXT.has(ext)) return { kind: "model" as const, bytes: bytes.length, sha256: sha, model: inspectGltf(bytes, path.basename(file)) };
    throw new EngineError("INVALID_ASSET", `Unsupported file type "${ext}". Images: png jpg jpeg webp; audio: wav mp3 m4a aac ogg flac; 3D models: glb gltf`);
  }

  /**
   * Copies a file into the workspace as a new asset. Importing byte-identical content again returns
   * the existing asset (reused: true) instead of duplicating it.
   */
  async importAsset(src: ImportSource, opts: { assetId?: string; name?: string; tags?: string[]; attachmentPoints?: AssetRecord["attachmentPoints"] } = {}) {
    const filename = src.kind === "file" ? path.basename(src.file) : src.filename;
    const ext = path.extname(filename).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !AUDIO_EXT.has(ext) && !MODEL_EXT.has(ext)) {
      throw new EngineError("INVALID_ASSET", `Unsupported file type "${ext || filename}"`, { filename });
    }
    const data = src.kind === "file" ? fs.readFileSync(src.file) : src.data;
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    if (!opts.assetId) {
      const existing = this.listAssets().find((a) => a.sha256 === sha && a.provenance.operation === "import");
      if (existing) return { asset: existing, reused: true };
    }
    const id = this.freshAssetId(opts.assetId, opts.name ?? filename);
    const dir = this.assetDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}${ext}`);
    try {
      writeFileAtomic(file, data);
      const d = await this.describeFile(file);
      const rec: AssetRecord = {
        assetId: id,
        name: opts.name ?? filename,
        mime: MIME[ext],
        file: this.rel(file),
        ...d,
        tags: opts.tags ?? [],
        ...(opts.attachmentPoints ? { attachmentPoints: opts.attachmentPoints } : {}),
        createdAt: now(),
        provenance: { operation: "import", source: src.origin },
      };
      this.writeAsset(rec);
      return { asset: rec, reused: false };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  updateAsset(id: string, patch: { name?: string; tags?: string[]; attachmentPoints?: AssetRecord["attachmentPoints"] | null }) {
    const rec = this.getAsset(id);
    if (patch.name !== undefined) rec.name = patch.name;
    if (patch.tags !== undefined) rec.tags = patch.tags;
    if (patch.attachmentPoints === null) delete rec.attachmentPoints;
    else if (patch.attachmentPoints !== undefined) rec.attachmentPoints = patch.attachmentPoints;
    this.writeAsset(rec);
    this.engines.clear(); // attachment points feed layout
    return rec;
  }

  private requireImage(id: string): AssetRecord {
    const rec = this.getAsset(id);
    if (rec.kind !== "image") throw new EngineError("INVALID_ASSET", `Asset "${id}" is ${rec.kind}, not an image`, { assetId: id });
    return rec;
  }

  /** Writes (if needed) the small checkerboard-backed JPEG of an image asset. */
  async assetView(id: string) {
    const rec = this.requireImage(id);
    const out = path.join(this.assetDir(id), "view.jpg");
    const v = fs.existsSync(out) ? { ...(await sharp(out).metadata()), bytes: fs.statSync(out).size } : await makeViewImage(this.abs(rec.file), out);
    return { relativePath: this.rel(out), width: v.width!, height: v.height!, bytes: v.bytes };
  }

  async inspectAsset(id: string) {
    const rec = this.getAsset(id);
    if (rec.kind === "model") return { asset: rec, ...(await this.modelView(id)) };
    if (rec.kind !== "image") return { asset: rec };
    const inspection = await inspectImage(this.abs(rec.file));
    return { asset: rec, inspection, view: await this.assetView(id) };
  }

  /**
   * Renders (once, cached) a framed thumbnail of a model with the 3D backend, which also proves
   * the model imports in Blender. Without Blender the model facts are still available.
   */
  async modelView(id: string): Promise<{ view?: ArtifactRecord["view"]; blender?: Record<string, unknown>; note?: string }> {
    const rec = this.getAsset(id);
    const dir = this.assetDir(id);
    const out = path.join(dir, "view.jpg");
    const facts = path.join(dir, "blender.json");
    if (!fs.existsSync(out) || !fs.existsSync(facts)) {
      const png = path.join(dir, `.thumb_${process.pid}.png`);
      try {
        const info = await modelThumbnail(this.abs(rec.file), png);
        await makeViewImage(fs.readFileSync(png), out);
        writeFileAtomic(facts, JSON.stringify(info, null, 2));
      } catch (e) {
        if (e instanceof EngineError && e.code === "ENGINE_CAPABILITY_UNAVAILABLE") return { note: "No thumbnail: the 3D backend (Blender) is not installed" };
        throw e;
      } finally {
        fs.rmSync(png, { force: true });
      }
    }
    const m = await sharp(out).metadata();
    return { view: { relativePath: this.rel(out), width: m.width!, height: m.height!, bytes: fs.statSync(out).size }, blender: readJson(facts) };
  }

  private async deriveImage(
    sourceId: string,
    opts: { assetId?: string; name?: string; suffix: string },
    write: (dir: string, id: string) => Promise<{ file: string; provenance: AssetRecord["provenance"]; attachmentPoints?: AssetRecord["attachmentPoints"]; auxFiles?: Record<string, string> }>,
  ) {
    const src = this.requireImage(sourceId);
    const id = this.freshAssetId(opts.assetId, `${sourceId}_${opts.suffix}`);
    const dir = this.assetDir(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const r = await write(dir, id);
      const d = await this.describeFile(r.file);
      const rec: AssetRecord = {
        assetId: id,
        name: opts.name ?? `${src.name} (${opts.suffix})`,
        mime: "image/png",
        file: this.rel(r.file),
        ...d,
        tags: [...src.tags],
        ...(r.attachmentPoints ? { attachmentPoints: r.attachmentPoints } : {}),
        createdAt: now(),
        provenance: r.provenance,
        ...(r.auxFiles ? { auxFiles: r.auxFiles } : {}),
      };
      this.writeAsset(rec);
      return rec;
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * Background removal / alpha validation + trim (the engine asset pipeline). Creates a NEW asset;
   * the source asset is untouched.
   */
  async processAsset(sourceId: string, options: ProcessOptions & { force?: boolean } = {}, opts: { assetId?: string; name?: string } = {}) {
    let diagnostics: Record<string, unknown> = {};
    const rec = await this.deriveImage(sourceId, { ...opts, suffix: "processed" }, async (dir, id) => {
      const work = path.join(dir, "processing");
      const meta = await processAsset(this.assetFile(sourceId), work, options);
      diagnostics = {
        path: meta.path,
        detection: meta.detection && {
          detectedColorHex: meta.detection.detectedColorHex,
          borderUniformity: meta.detection.borderUniformity,
          sideUniformity: meta.detection.sideUniformity,
          confidence: meta.detection.confidence,
          noise: meta.detection.noise,
        },
        holes: meta.removal?.holes,
        removalStats: meta.removal?.stats,
        components: meta.components,
        removedComponents: meta.removedComponents,
        trim: meta.trim,
        alpha: meta.alpha,
        issues: meta.issues,
      };
      if (!meta.ok) {
        throw new EngineError("PROCESSING_FAILED", meta.issues.find((i) => i.severity === "error")?.message ?? "Asset processing failed", {
          sourceAssetId: sourceId,
          issues: meta.issues,
          hint: "If the background is intentionally not uniform, retry with options.force = true or use a different source",
        });
      }
      const file = path.join(dir, `${id}.png`);
      fs.renameSync(path.join(work, meta.files.processed), file);
      const aux: Record<string, string> = {};
      for (const [k, f] of [["backgroundMask", meta.files.backgroundMask], ["untrimmed", meta.files.untrimmed], ["metadata", meta.files.metadata]] as const) {
        if (f && fs.existsSync(path.join(work, f))) {
          const dst = path.join(dir, f);
          fs.renameSync(path.join(work, f), dst);
          aux[k] = this.rel(dst);
        }
      }
      fs.rmSync(work, { recursive: true, force: true }); // the original copy is redundant: the source asset keeps it
      return {
        file,
        auxFiles: aux,
        attachmentPoints: meta.attachmentPoints,
        provenance: { operation: "process", sourceAssetId: sourceId, options, diagnostics },
      };
    });
    return { asset: rec, diagnostics, view: await this.assetView(rec.assetId) };
  }

  /** Crops an image asset to its visible pixels. Attachment points are carried over. */
  async trimAsset(sourceId: string, options: TrimOptions = {}, opts: { assetId?: string; name?: string } = {}) {
    const src = this.requireImage(sourceId);
    let info: unknown;
    const rec = await this.deriveImage(sourceId, { ...opts, suffix: "trimmed" }, async (dir, id) => {
      const { image } = await readRgba(this.abs(src.file));
      const t = trimTransparent(image, options);
      if (t.info.empty) throw new EngineError("INVALID_ASSET", `Asset "${sourceId}" has no visible pixels to trim to`, { assetId: sourceId });
      info = t.info;
      const file = path.join(dir, `${id}.png`);
      await writePng(t.image, file);
      let points: AssetRecord["attachmentPoints"];
      if (src.attachmentPoints) {
        points = {};
        for (const [k, p] of Object.entries(src.attachmentPoints)) {
          points[k] = {
            x: +((p.x * image.width - t.info.offsetX) / t.info.trimmedWidth).toFixed(4),
            y: +((p.y * image.height - t.info.offsetY) / t.info.trimmedHeight).toFixed(4),
          };
        }
      }
      return { file, attachmentPoints: points, provenance: { operation: "trim", sourceAssetId: sourceId, options, diagnostics: t.info } };
    });
    return { asset: rec, trim: info, view: await this.assetView(rec.assetId) };
  }

  async assetComponents(id: string, alphaThreshold = 8) {
    const { image } = await readRgba(this.abs(this.requireImage(id).file));
    return findComponents(image, alphaThreshold).components;
  }

  async removeAssetComponents(sourceId: string, componentIds: number[], alphaThreshold = 8, opts: { assetId?: string; name?: string } = {}) {
    const known = (await this.assetComponents(sourceId, alphaThreshold)).map((c) => c.id);
    const unknown = componentIds.filter((c) => !known.includes(c));
    if (unknown.length) {
      throw new EngineError("INVALID_ARGUMENT", `Unknown component id(s) ${unknown.join(", ")} for asset "${sourceId}"`, { known });
    }
    let removedPixels = 0;
    const rec = await this.deriveImage(sourceId, { ...opts, suffix: "cleaned" }, async (dir, id) => {
      const { image } = await readRgba(this.assetFile(sourceId));
      const r = removeComponents(image, componentIds, alphaThreshold);
      removedPixels = r.removedPixels;
      const file = path.join(dir, `${id}.png`);
      await writePng(r.image, file);
      return {
        file,
        attachmentPoints: this.getAsset(sourceId).attachmentPoints,
        provenance: { operation: "component_remove", sourceAssetId: sourceId, options: { componentIds, alphaThreshold } },
      };
    });
    return { asset: rec, removedPixels, view: await this.assetView(rec.assetId) };
  }

  // ---- scenes ------------------------------------------------------------------------------

  private sceneFile(id: string) {
    return path.join(this.dir, "scenes", `${id}.json`);
  }

  hasScene(id: string) {
    return fs.existsSync(this.sceneFile(id));
  }

  listScenes() {
    const dir = path.join(this.dir, "scenes");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const id = f.slice(0, -5);
        const doc = readJson<ops.SceneDoc>(path.join(dir, f));
        return {
          sceneId: id,
          kind: ops.is3D(doc) ? ("3d" as const) : ("2d" as const),
          name: doc.name ?? id,
          canvas: doc.canvas,
          duration: doc.duration,
          ...(ops.is3D(doc) ? { objects: (doc.objects ?? []).length, lights: (doc.lights ?? []).length } : { layers: (doc.layers ?? []).length }),
          tracks: (doc.animations ?? []).length,
          ...(doc.characters?.length ? { characters: doc.characters.map((c: any) => `${c.id} (${c.character})`) } : {}),
        };
      });
  }

  /** The stored engine scene document. */
  getSceneDoc(id: string): ops.SceneDoc {
    checkEntityId("scene", id);
    if (!this.hasScene(id)) {
      throw new EngineError("SCENE_NOT_FOUND", `Scene "${id}" does not exist in workspace "${this.id}"`, {
        sceneId: id,
        available: this.listScenes().map((s) => s.sceneId),
      });
    }
    return readJson<ops.SceneDoc>(this.sceneFile(id));
  }

  /**
   * Scene as seen by clients: the engine document without the internal asset-file map
   * (layers reference assets by id; `assetsUsed` lists them) and with audio referenced by assetId.
   */
  sceneView(id: string) {
    const doc = this.getSceneDoc(id);
    const { assets, audio, ...rest } = doc;
    const byFile = new Map(this.listAssets().map((a) => [a.file, a.assetId]));
    return {
      sceneId: id,
      ...(ops.is3D(doc) ? {} : { kind: "2d" }),
      ...rest,
      audio: (audio ?? []).map((a: any) => ({ assetId: byFile.get(a.src) ?? null, startFrame: a.startFrame ?? 0, volume: a.volume ?? 1 })),
      assetsUsed: ops.is3D(doc) ? [...new Set((doc.objects ?? []).map((o: any) => o.asset).filter(Boolean))] : Object.keys(assets ?? {}),
    };
  }

  private withAllAssets(doc: ops.SceneDoc): ops.SceneDoc {
    const assets: Record<string, unknown> = {};
    for (const rec of this.listAssets({ kind: "image" })) {
      assets[rec.assetId] = { src: rec.file, ...(rec.attachmentPoints ? { attachmentPoints: rec.attachmentPoints } : {}) };
    }
    return { ...doc, assets };
  }

  /** Rebuilds the scene's asset map from the asset ids it references (layers + asset keyframes). */
  private syncSceneAssets(doc: ops.SceneDoc): ops.SceneDoc {
    const ids = new Set<string>();
    for (const l of doc.layers ?? []) if (typeof l.asset === "string") ids.add(l.asset);
    for (const a of doc.animations ?? []) {
      if (a.property === "asset") for (const k of a.keyframes ?? []) if (typeof k.value === "string") ids.add(k.value);
    }
    const assets: Record<string, unknown> = {};
    for (const id of [...ids].sort()) {
      if (!/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(id) || !this.hasAsset(id)) continue; // left missing -> validation reports it
      const rec = this.getAsset(id);
      if (rec.kind !== "image") continue;
      assets[id] = { src: rec.file, ...(rec.attachmentPoints ? { attachmentPoints: rec.attachmentPoints } : {}) };
    }
    return { ...doc, assets };
  }

  /** Model lookup for 3D validation: every model asset of the workspace, by id. */
  assetLookup3D: AssetLookup3D = (assetId) => {
    if (!/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(assetId) || !this.hasAsset(assetId)) return undefined;
    const rec = this.getAsset(assetId);
    return { kind: rec.kind, model: rec.model };
  };

  private validateDoc3D(id: string, doc: ops.SceneDoc): ValidationIssue[] {
    const v = validateScene3D(doc, this.assetLookup3D);
    const errors = [...v.errors];
    if (v.ok) {
      v.scene!.objects.forEach((o, i) => {
        if (o.asset && !fs.existsSync(this.assetFile(o.asset))) {
          errors.push({ severity: "error", code: "MISSING_ASSET_FILE", path: ["objects", i, "asset"], message: `The file of asset "${o.asset}" is missing` });
        }
      });
      const ov = v.scene!.overlay;
      if (ov) {
        const bad = (message: string) => errors.push({ severity: "error", code: "INVALID_VALUE", path: ["overlay", "scene"], message });
        if (!/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(ov.scene) || !this.hasScene(ov.scene)) bad(`Overlay scene "${ov.scene}" does not exist`);
        else {
          const o2 = this.getSceneDoc(ov.scene);
          const c = v.scene!.canvas;
          if (ops.is3D(o2)) bad(`Overlay scene "${ov.scene}" must be a 2D scene`);
          else if (o2.canvas.width !== c.width || o2.canvas.height !== c.height || o2.canvas.fps !== c.fps) {
            bad(`Overlay scene "${ov.scene}" must have the same canvas size and fps (${c.width}x${c.height} @ ${c.fps})`);
          }
        }
      }
    }
    if (errors.length) throw errorFromIssues(errors, { sceneId: id, availableAssets: this.listAssets({ kind: "model" }).map((a) => a.assetId).slice(0, 50) });
    return v.warnings;
  }

  private validateDoc(id: string, doc: ops.SceneDoc): ValidationIssue[] {
    if (ops.is3D(doc)) return this.validateDoc3D(id, doc);
    const v = validateScene(doc, { baseDir: this.dir });
    if (!v.ok) {
      // report unknown assets with the workspace's asset list so a client can fix the id
      throw errorFromIssues(v.errors, { sceneId: id, availableAssets: this.listAssets().map((a) => a.assetId).slice(0, 50) });
    }
    return v.warnings;
  }

  private async withSceneLock<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.sceneLocks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.sceneLocks.set(id, next.catch(() => undefined));
    return next;
  }

  async createScene(args: { sceneId?: string; kind?: "2d" | "3d"; name?: string; canvas?: Record<string, unknown>; duration?: number; camera?: Record<string, unknown> } = {}) {
    const id = args.sceneId ? checkEntityId("scene", args.sceneId) : this.nextFreeSceneId();
    if (this.hasScene(id)) throw new EngineError("SCENE_EXISTS", `Scene "${id}" already exists`, { sceneId: id });
    if (args.kind === "3d") {
      const r = ops3d.createScene3D({ name: args.name ?? id, canvas: args.canvas as any, duration: args.duration });
      if (!r.ok) throw errorFromIssues(r.errors, { sceneId: id });
      let doc = r.scene;
      if (args.camera) {
        const c = ops.withAssets3D(this.assetLookup3D, () => ops3d.setSettings3D(doc, { camera: args.camera }));
        if (!c.ok) throw errorFromIssues(c.errors, { sceneId: id });
        doc = c.scene;
      }
      const warnings = this.validateDoc(id, doc);
      writeFileAtomic(this.sceneFile(id), JSON.stringify(doc, null, 2));
      return { sceneId: id, kind: "3d" as const, warnings };
    }
    const r = ops.createScene({ name: args.name ?? id, canvas: args.canvas as any, duration: args.duration });
    if (!r.ok) throw errorFromIssues(r.errors, { sceneId: id });
    let doc = r.scene;
    if (args.camera) {
      const c = ops.setCamera(doc, args.camera);
      if (!c.ok) throw errorFromIssues(c.errors, { sceneId: id });
      doc = c.scene;
    }
    doc = this.syncSceneAssets(doc);
    const warnings = this.validateDoc(id, doc);
    writeFileAtomic(this.sceneFile(id), JSON.stringify(doc, null, 2));
    return { sceneId: id, kind: "2d" as const, warnings };
  }

  private nextFreeSceneId() {
    let id = this.nextId("scene");
    while (this.hasScene(id)) id = this.nextId("scene");
    return id;
  }

  deleteScene(id: string) {
    this.getSceneDoc(id);
    fs.rmSync(this.sceneFile(id));
    this.engines.delete(id);
  }

  /**
   * The one way to change a scene: `fn` returns an operations result for the current document; the
   * new document gets its asset map synced, is fully validated (including asset files) and is only
   * then written. Any failure leaves the stored scene untouched.
   */
  async mutateScene<T>(id: string, fn: (doc: ops.SceneDoc) => ops.OpResult<T>) {
    return this.withSceneLock(id, () => {
      const cur = this.getSceneDoc(id);
      if (ops.is3D(cur)) {
        // 3D scenes reference model assets by id directly (no internal file map)
        const r = ops.withAssets3D(this.assetLookup3D, () => fn(cur));
        if (!r.ok) throw errorFromIssues(r.errors, { sceneId: id });
        const warnings = this.validateDoc(id, r.scene);
        writeFileAtomic(this.sceneFile(id), JSON.stringify(r.scene, null, 2));
        return { result: r.result as T | undefined, warnings: [...r.warnings, ...warnings] };
      }
      // expose every image asset during the operation so references resolve; sync prunes afterwards
      const doc = this.withAllAssets(cur);
      const r = fn(doc);
      if (!r.ok) throw errorFromIssues(r.errors, { sceneId: id, availableAssets: undefined });
      const next = this.syncSceneAssets(r.scene);
      const warnings = this.validateDoc(id, next);
      writeFileAtomic(this.sceneFile(id), JSON.stringify(next, null, 2));
      return { result: r.result as T | undefined, warnings: [...r.warnings, ...warnings] };
    });
  }

  /** Maps scene audio given by assetId to the engine's file-based audio entries. */
  audioEntries(audio: { assetId: string; startFrame?: number; volume?: number }[]) {
    return audio.map((a) => {
      const rec = this.getAsset(a.assetId);
      if (rec.kind !== "audio") throw new EngineError("INVALID_ASSET", `Asset "${a.assetId}" is not audio`, { assetId: a.assetId });
      return { src: rec.file, startFrame: a.startFrame ?? 0, volume: a.volume ?? 1 };
    });
  }

  /** A prepared engine for the scene's current document (cached until the document changes). */
  async engine(id: string): Promise<AnimationEngine> {
    const raw = this.getSceneDoc(id);
    if (ops.is3D(raw)) throw new EngineError("INVALID_ARGUMENT", `Scene "${id}" is a 3D scene; use the 3D operations (measure_3d / 3D render)`, { sceneId: id, kind: "3d" });
    const doc = this.syncSceneAssets(raw);
    // the cache key covers the document AND the state of every referenced file, so a changed or
    // deleted asset/audio file is noticed (and reported) instead of rendering stale bytes
    const files = [...Object.values(doc.assets ?? {}).map((a: any) => a.src), ...(doc.audio ?? []).map((a: any) => a.src)].map((rel: string) => {
      try {
        const st = fs.statSync(path.join(this.dir, rel));
        return `${rel}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${rel}:missing`;
      }
    });
    const hash = crypto.createHash("sha256").update(JSON.stringify(doc)).update(files.join("|")).digest("hex");
    const cached = this.engines.get(id);
    if (cached?.hash === hash) return cached.engine;
    const engine = new AnimationEngine(doc, this.dir);
    try {
      await engine.prepare();
    } catch (e: any) {
      if (e?.issues) throw errorFromIssues(e.issues, { sceneId: id });
      throw e;
    }
    this.engines.set(id, { hash, engine });
    return engine;
  }

  async measureLayout(id: string, frame: number, layers?: string[]): Promise<FrameLayout> {
    return (await this.engine(id)).measureLayout(frame, { layers });
  }

  // ---- prepared characters -----------------------------------------------------------------

  private characterDir(id: string) {
    return path.join(this.dir, "characters", id);
  }

  hasCharacter(id: string) {
    return /^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(id) && fs.existsSync(path.join(this.characterDir(id), "character.json"));
  }

  /**
   * Prepares a character in this workspace ONCE from a package directory (character.json + its
   * files): every file becomes a workspace asset (<id>.<name>), the definition is stored with
   * asset ids. Importing the same package again is a no-op (reused: true); a changed package
   * needs replace: true.
   */
  async importCharacter(pkgDir: string, opts: { characterId?: string; replace?: boolean; origin?: Record<string, unknown> } = {}) {
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(pkgDir, "character.json"), "utf8"));
    } catch (e) {
      throw new EngineError("INVALID_ASSET", `Unreadable character.json: ${e instanceof Error ? e.message : e}`);
    }
    if (opts.characterId) raw.id = opts.characterId;
    const parsed = CharacterDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new EngineError("INVALID_ASSET", `Invalid character definition: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`, {
        issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }
    const def = parsed.data;
    checkEntityId("character", def.id);
    const files: [string, string][] = def.kind === "2d" ? Object.entries(def.assets) : [["model", def.model]];
    const hashes = files.map(([n, f]) => {
      const file = resolveInside(pkgDir, f);
      if (!fs.existsSync(file)) throw new EngineError("INVALID_ASSET", `Character package file missing: ${f}`, { asset: n });
      return `${n}:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`;
    });
    const packageSha = crypto.createHash("sha256").update(JSON.stringify(def)).update(hashes.sort().join("|")).digest("hex");
    if (this.hasCharacter(def.id)) {
      const meta = readJson<{ packageSha: string }>(path.join(this.characterDir(def.id), "meta.json"));
      if (meta.packageSha === packageSha) return { character: this.getCharacter(def.id), reused: true };
      if (!opts.replace) {
        throw new EngineError("CHARACTER_EXISTS", `Character "${def.id}" is already prepared in this workspace from a different package; pass replace: true to update it`, { characterId: def.id });
      }
    }
    const mapped: Record<string, string> = {};
    for (const [name, f] of files) {
      const assetId = `${def.id}.${name.replace(/[^A-Za-z0-9_\-.]/g, "_")}`;
      const file = resolveInside(pkgDir, f);
      const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      if (this.hasAsset(assetId)) {
        if (this.getAsset(assetId).sha256 === sha) {
          mapped[name] = assetId;
          continue;
        }
        fs.rmSync(this.assetDir(assetId), { recursive: true, force: true });
        this.engines.clear();
      }
      await this.importAsset({ kind: "file", file, origin: { character: def.id, file: f, ...opts.origin } }, { assetId, name: `${def.id} ${name}`, tags: ["character", def.id] });
      mapped[name] = assetId;
    }
    const stored: CharacterDefinition = def.kind === "2d" ? { ...def, assets: mapped } : { ...def, model: mapped.model };
    const sha = crypto.createHash("sha256").update(JSON.stringify(stored)).digest("hex");
    const continuity = await this.characterContinuity(stored);
    writeFileAtomic(path.join(this.characterDir(def.id), "character.json"), JSON.stringify(stored, null, 2));
    writeFileAtomic(path.join(this.characterDir(def.id), "meta.json"), JSON.stringify({ characterId: def.id, sha, packageSha, importedAt: now(), origin: opts.origin ?? {}, continuity }, null, 2));
    return { character: this.getCharacter(def.id), reused: false };
  }

  /**
   * Whether the character stays visually connected when its skeleton moves (checked once, at
   * preparation). 2D: joint-disk coverage of the real part art over the motions' angle ranges.
   * 3D: skin weights (every moving joint blended or connected, none rigid).
   */
  private async characterContinuity(def: CharacterDefinition) {
    if (def.kind === "3d") {
      const sk = this.getAsset(def.model).model?.skinning;
      return sk
        ? { method: "3d skinning: joint weights", continuous: sk.continuous, productionReady: sk.continuous, rigidJoints: sk.rigidJoints, maxInfluences: sk.maxInfluences, joints: sk.joints }
        : { method: "3d skinning: joint weights", continuous: false, productionReady: false, note: "model has no readable skin weights" };
    }
    const images: Record<string, AlphaImage> = {};
    for (const [name, assetId] of Object.entries(def.assets)) {
      const { data, info } = await sharp(this.assetFile(assetId)).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
      images[name] = { width: info.width, height: info.height, alpha: new Uint8Array(data) };
    }
    const r = analyzeJoints2D(def, (n) => images[n]);
    return { ...r, productionReady: r.continuous };
  }

  getCharacter(id: string): { def: CharacterDefinition; sha: string; meta: Record<string, unknown> } {
    checkEntityId("character", id);
    if (!this.hasCharacter(id)) {
      throw new EngineError("CHARACTER_NOT_FOUND", `No prepared character "${id}" in workspace "${this.id}" (character_import it from a library first)`, {
        characterId: id,
        available: this.listCharacters().map((c) => c.characterId),
      });
    }
    const def = CharacterDefinitionSchema.parse(readJson(path.join(this.characterDir(id), "character.json")));
    const meta = readJson<Record<string, unknown>>(path.join(this.characterDir(id), "meta.json"));
    return { def, sha: String(meta.sha), meta };
  }

  listCharacters() {
    const dir = path.join(this.dir, "characters");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((id) => this.hasCharacter(id))
      .sort()
      .map((id) => {
        const { def, sha } = this.getCharacter(id);
        const d = describeCharacter(def);
        return { characterId: id, name: d.name, kind: def.kind, sha256: sha, actions: d.actions.map((a) => a.name), expressions: d.expressions };
      });
  }

  describeCharacter(id: string) {
    const { def, sha, meta } = this.getCharacter(id);
    return { ...describeCharacter(def, sha), continuity: (meta.continuity as Record<string, unknown> | undefined) ?? null };
  }

  saveSpeechTiming(id: string, timing: unknown) {
    checkEntityId("speech", id);
    const p = SpeechTimingSchema.safeParse(timing);
    if (!p.success) throw new EngineError("INVALID_ARGUMENT", `Invalid speech timing: ${p.error.issues[0]?.path.join(".")}: ${p.error.issues[0]?.message}`);
    if (p.data.audio) {
      const rec = this.getAsset(p.data.audio);
      if (rec.kind !== "audio") throw new EngineError("INVALID_ASSET", `Asset "${p.data.audio}" is not audio`, { assetId: p.data.audio });
    }
    writeFileAtomic(path.join(this.dir, "speech", `${id}.json`), JSON.stringify(timing, null, 2));
    return p.data;
  }

  getSpeechTiming(id: string): SpeechTiming | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(id)) return undefined;
    const f = path.join(this.dir, "speech", `${id}.json`);
    return fs.existsSync(f) ? SpeechTimingSchema.parse(readJson(f)) : undefined;
  }

  listSpeechTimings() {
    const dir = path.join(this.dir, "speech");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort() : [];
  }

  /** Lookups the character runtime needs (definitions, speech timings, audio files). */
  characterContext(): CharacterContext {
    return {
      definition: (id) => {
        if (!this.hasCharacter(id)) return undefined;
        const c = this.getCharacter(id);
        return { ...c, continuity: c.meta.continuity as { continuous: boolean } | undefined };
      },
      speech: (id) => this.getSpeechTiming(id),
      audioSrc: (assetId) => (/^[A-Za-z_][A-Za-z0-9_\-.]*$/.test(assetId) && this.hasAsset(assetId) && this.getAsset(assetId).kind === "audio" ? this.getAsset(assetId).file : undefined),
    };
  }

  // ---- 3D ------------------------------------------------------------------------------------

  sceneKind(id: string): "2d" | "3d" {
    return ops.is3D(this.getSceneDoc(id)) ? "3d" : "2d";
  }

  /** Validated 3D scene with model/file lookups for the 3D backend. */
  scene3D(id: string): Scene3DContext {
    const doc = this.getSceneDoc(id);
    if (!ops.is3D(doc)) throw new EngineError("INVALID_ARGUMENT", `Scene "${id}" is a 2D scene`, { sceneId: id, kind: "2d" });
    this.validateDoc3D(id, doc);
    const scene = validateScene3D(doc, this.assetLookup3D).scene as Scene3D;
    return { scene, model: (a) => this.assetLookup3D(a)?.model, assetFile: (a) => this.assetFile(a) };
  }

  /** Validates the scene (2D or 3D) and returns its duration in frames. */
  async sceneDuration(id: string): Promise<number> {
    return this.sceneKind(id) === "3d" ? this.scene3D(id).scene.duration : (await this.engine(id)).scene.duration;
  }

  async measure3D(id: string, frame: number, opts: Measure3DOptions = {}) {
    return measure3D(this.scene3D(id), frame, opts);
  }

  /** RGBA frame of a 3D scene: backend PNG + optional 2D overlay, flattened on the background if asked. */
  private async compose3D(ctx: Scene3DContext, frame: number, png: Buffer | string, flatten: boolean): Promise<Buffer> {
    const { width, height } = ctx.scene.canvas;
    let img = sharp(png).ensureAlpha();
    const layers: { input: Buffer; raw: { width: number; height: number; channels: 4 } }[] = [];
    if (ctx.scene.overlay) {
      const f = await (await this.engine(ctx.scene.overlay.scene)).renderFrame(frame);
      layers.push({ input: f.rgba(), raw: { width, height, channels: 4 } });
    }
    if (layers.length) img = sharp(await img.composite(layers).png().toBuffer());
    if (flatten) img = img.flatten({ background: ctx.scene.canvas.background.slice(0, 7) }).ensureAlpha();
    return img.raw().toBuffer();
  }

  private debugSvg(m: Awaited<ReturnType<typeof measure3D>>) {
    const { width: W, height: H } = m.canvas;
    const esc = (t: string) => t.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
    const fs1 = Math.max(11, Math.round(H / 55));
    const parts: string[] = [];
    const colors = ["#ff3b30", "#34c759", "#007aff", "#ff9500", "#af52de", "#00c7be", "#ffcc00"];
    m.objects.forEach((o: any, i: number) => {
      const c = colors[i % colors.length];
      const sc = o.screen;
      if (sc?.onScreen && sc.width < W * 3) {
        parts.push(`<rect x="${sc.x}" y="${sc.y}" width="${sc.width}" height="${sc.height}" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="6 3"/>`);
        const label = `${o.id}${o.clips?.length ? " [" + o.clips.map((k: any) => k.name).join("→") + "]" : ""} z${o.cameraSpace?.depth?.toFixed(1)}m`;
        parts.push(`<text x="${Math.max(2, sc.x) + 3}" y="${Math.max(fs1, sc.y) + fs1}" fill="${c}" font-size="${fs1}" font-family="sans-serif" font-weight="bold" stroke="#000" stroke-width="0.6">${esc(label)}</text>`);
      }
      for (const [name, b] of Object.entries<any>(o.bones ?? {})) {
        if (!b.screen.onScreen || !/Hand$|^head$|^root$/.test(name)) continue;
        parts.push(`<circle cx="${b.screen.x}" cy="${b.screen.y}" r="4" fill="${c}" stroke="#fff" stroke-width="1.5"/>`);
        parts.push(`<text x="${b.screen.x + 6}" y="${b.screen.y - 4}" fill="#fff" font-size="${Math.round(fs1 * 0.8)}" font-family="sans-serif" stroke="#000" stroke-width="0.5">${esc(name)}</text>`);
      }
    });
    const cam = m.camera as any;
    parts.push(`<text x="6" y="${H - 8}" fill="#fff" font-size="${fs1}" font-family="monospace" stroke="#000" stroke-width="0.5">${esc(`frame ${m.frame}  camera (${cam.position.x}, ${cam.position.y}, ${cam.position.z}) fov ${cam.fov}`)}</text>`);
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`);
  }

  private async renderPreview3D(sceneId: string, frame: number, opts: { debug?: boolean; quality?: "draft" | "standard" | "high" }) {
    const ctx = this.scene3D(sceneId);
    const tmp = path.join(this.dir, "previews", `.tmp3d_${process.pid}_${Date.now()}.png`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    try {
      const r = await renderFrames3D(ctx, [{ frame, out: tmp }], { quality: opts.quality ?? "draft", ...(opts.debug ? { measure: {} } : {}) });
      const { width, height } = ctx.scene.canvas;
      let png = await sharp(await this.compose3D(ctx, frame, tmp, false), { raw: { width, height, channels: 4 } }).png().toBuffer();
      if (opts.debug && r.measurements[0]) png = await sharp(png).composite([{ input: this.debugSvg(r.measurements[0]) }]).png().toBuffer();
      const rec = await this.imageArtifact(opts.debug ? "debug-preview" : "preview", sceneId, frame, png, "previews");
      return opts.debug ? { ...rec, measurement: r.measurements[0] } : rec;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private async renderVideo3D(
    sceneId: string,
    o: { startFrame?: number; endFrame?: number; crf?: number; audio?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; renderId?: string },
  ) {
    const ctx = this.scene3D(sceneId);
    const s = ctx.scene;
    const start = o.startFrame ?? 0;
    const end = o.endFrame ?? s.duration;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= s.duration && end > start)) {
      throw new EngineError("INVALID_FRAME", `invalid frame range [${start}, ${end}) for duration ${s.duration}`, { startFrame: start, endFrame: end, duration: s.duration });
    }
    const artifactId = this.nextId("video");
    const file = path.join(this.dir, "renders", `${sceneId}_${artifactId}.mp4`);
    const tmpDir = path.join(this.dir, "renders", `.frames_${artifactId}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const fps = s.canvas.fps;
    const audio = o.audio === false ? [] : s.audio.map((a) => ({ file: this.abs(a.src), start: (a.startFrame - start) / fps, volume: a.volume })).filter((a) => a.start >= 0);
    const enc = startEncoder({ out: file, width: s.canvas.width, height: s.canvas.height, fps, frameCount: end - start, audio, crf: o.crf });
    let chain = Promise.resolve();
    let encoded = 0;
    let poster: Buffer | null = null;
    try {
      const frames = Array.from({ length: end - start }, (_, i) => ({ frame: start + i, out: path.join(tmpDir, `f${String(start + i).padStart(6, "0")}.png`) }));
      await renderFrames3D(ctx, frames, {
        signal: o.signal,
        onFrame: (frame, png) => {
          chain = chain.then(async () => {
            const rgba = await this.compose3D(ctx, frame, png, true);
            if (!poster) poster = await sharp(rgba, { raw: { width: s.canvas.width, height: s.canvas.height, channels: 4 } }).png().toBuffer();
            await enc.write(rgba);
            fs.rmSync(png, { force: true });
            o.onProgress?.(++encoded, end - start);
          });
        },
      });
      await chain;
      await enc.finish();
    } catch (e) {
      await chain.catch(() => undefined);
      await enc.abort();
      if (e instanceof EngineError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new EngineError(/ffmpeg/i.test(msg) ? "FFMPEG_FAILED" : "RENDER_FAILED", msg);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    const view = await makeViewImage(poster!, path.join(this.dir, "renders", `${sceneId}_${artifactId}.poster.jpg`));
    return this.saveArtifact({
      artifactId,
      kind: "video",
      sceneId,
      startFrame: start,
      endFrame: end,
      width: s.canvas.width,
      height: s.canvas.height,
      durationSeconds: (end - start) / fps,
      relativePath: this.rel(file),
      bytes: fs.statSync(file).size,
      view: { relativePath: `renders/${sceneId}_${artifactId}.poster.jpg`, ...view },
      ...(o.renderId ? { renderId: o.renderId } : {}),
      createdAt: now(),
    });
  }

  // ---- artifacts & rendering --------------------------------------------------------------

  private saveArtifact(rec: ArtifactRecord) {
    writeFileAtomic(path.join(this.dir, "artifacts", `${rec.artifactId}.json`), JSON.stringify(rec, null, 2));
    return rec;
  }

  getArtifact(id: string): ArtifactRecord {
    checkEntityId("artifact", id);
    const f = path.join(this.dir, "artifacts", `${id}.json`);
    if (!fs.existsSync(f)) throw new EngineError("ARTIFACT_NOT_FOUND", `Artifact "${id}" does not exist`, { artifactId: id });
    return readJson<ArtifactRecord>(f);
  }

  listArtifacts(filter: { kind?: string; sceneId?: string } = {}): ArtifactRecord[] {
    const dir = path.join(this.dir, "artifacts");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<ArtifactRecord>(path.join(dir, f)))
      .filter((a) => (!filter.kind || a.kind === filter.kind) && (!filter.sceneId || a.sceneId === filter.sceneId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async imageArtifact(kind: ArtifactKind, sceneId: string, frame: number, png: Buffer, subdir: string) {
    const artifactId = this.nextId(kind === "debug-preview" ? "debug" : kind);
    const base = `${sceneId}_f${frame}_${artifactId}`;
    const file = path.join(this.dir, subdir, `${base}.png`);
    writeFileAtomic(file, png);
    const meta = await sharp(png).metadata();
    const view = await makeViewImage(png, path.join(this.dir, subdir, `${base}.view.jpg`));
    return this.saveArtifact({
      artifactId,
      kind,
      sceneId,
      frame,
      width: meta.width!,
      height: meta.height!,
      relativePath: this.rel(file),
      bytes: png.length,
      view: { relativePath: `${subdir}/${base}.view.jpg`, ...view },
      createdAt: now(),
    });
  }

  /** Normal preview (debug=false) or debug preview with bounds/ids/pivots/z/attachment overlays. */
  async renderPreview(sceneId: string, frame: number, opts: { debug?: boolean; debugOptions?: DebugOptions; quality?: "draft" | "standard" | "high" } = {}) {
    if (this.sceneKind(sceneId) === "3d") return this.renderPreview3D(sceneId, frame, opts);
    const engine = await this.engine(sceneId);
    const tmp = path.join(this.dir, "previews", `.tmp_${process.pid}_${Date.now()}.png`);
    try {
      if (opts.debug) await engine.renderDebugPreview(frame, tmp, opts.debugOptions);
      else await engine.renderPreview(frame, tmp);
      return await this.imageArtifact(opts.debug ? "debug-preview" : "preview", sceneId, frame, fs.readFileSync(tmp), "previews");
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** One frame through the same deterministic path as video rendering; also returns its pixel hash. */
  async renderFrame(sceneId: string, frame: number) {
    if (this.sceneKind(sceneId) === "3d") {
      const ctx = this.scene3D(sceneId);
      const tmp = path.join(this.dir, "frames", `.tmp3d_${process.pid}_${Date.now()}.png`);
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      try {
        await renderFrames3D(ctx, [{ frame, out: tmp }]);
        const { width, height } = ctx.scene.canvas;
        const rgba = await this.compose3D(ctx, frame, tmp, false);
        const rec = await this.imageArtifact("frame", sceneId, frame, await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer(), "frames");
        return { ...rec, pixelSha256: crypto.createHash("sha256").update(rgba).digest("hex") };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const engine = await this.engine(sceneId);
    const f = await engine.renderFrame(frame);
    const sha256 = crypto.createHash("sha256").update(f.rgba()).digest("hex");
    const rec = await this.imageArtifact("frame", sceneId, frame, await f.png(), "frames");
    return { ...rec, pixelSha256: sha256 };
  }

  /** Renders [startFrame, endFrame) to MP4 (H.264 + scene audio). Prefer RenderJobs for long renders. */
  async renderVideo(
    sceneId: string,
    o: { startFrame?: number; endFrame?: number; crf?: number; audio?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; renderId?: string } = {},
  ) {
    if (this.sceneKind(sceneId) === "3d") return this.renderVideo3D(sceneId, o);
    const engine = await this.engine(sceneId);
    const artifactId = this.nextId("video");
    const file = path.join(this.dir, "renders", `${sceneId}_${artifactId}.mp4`);
    const r = await engine.renderVideo(file, { startFrame: o.startFrame, endFrame: o.endFrame, crf: o.crf, audio: o.audio, signal: o.signal, onProgress: o.onProgress });
    const start = o.startFrame ?? 0;
    const poster = await engine.renderFrame(start);
    const view = await makeViewImage(await poster.png(), path.join(this.dir, "renders", `${sceneId}_${artifactId}.poster.jpg`));
    return this.saveArtifact({
      artifactId,
      kind: "video",
      sceneId,
      startFrame: start,
      endFrame: start + r.frames,
      width: engine.scene.canvas.width,
      height: engine.scene.canvas.height,
      durationSeconds: r.seconds,
      relativePath: this.rel(file),
      bytes: fs.statSync(file).size,
      view: { relativePath: `renders/${sceneId}_${artifactId}.poster.jpg`, ...view },
      ...(o.renderId ? { renderId: o.renderId } : {}),
      createdAt: now(),
    });
  }
}
