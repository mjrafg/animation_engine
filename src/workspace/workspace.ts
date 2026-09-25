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
import { checkEntityId, checkWorkspaceId, readJson, resolveInside, toPosix, writeFileAtomic } from "./paths.js";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const AUDIO_EXT = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac"]);
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

export interface AssetRecord {
  assetId: string;
  name: string;
  kind: "image" | "audio";
  /** Workspace-relative path of the asset file. */
  file: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
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
    const out: { path: string; kind: "image" | "audio"; bytes: number }[] = [];
    const limit = opts.limit ?? 500;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= limit) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else {
          const ext = path.extname(e.name).toLowerCase();
          const kind = IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : null;
          if (kind) out.push({ path: toPosix(path.relative(fs.realpathSync(root), full)), kind, bytes: fs.statSync(full).size });
        }
      }
    };
    walk(start);
    return out;
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
    throw new EngineError("INVALID_ASSET", `Unsupported file type "${ext}". Images: png jpg jpeg webp; audio: wav mp3 m4a aac ogg flac`);
  }

  /**
   * Copies a file into the workspace as a new asset. Importing byte-identical content again returns
   * the existing asset (reused: true) instead of duplicating it.
   */
  async importAsset(src: ImportSource, opts: { assetId?: string; name?: string; tags?: string[]; attachmentPoints?: AssetRecord["attachmentPoints"] } = {}) {
    const filename = src.kind === "file" ? path.basename(src.file) : src.filename;
    const ext = path.extname(filename).toLowerCase();
    if (!IMAGE_EXT.has(ext) && !AUDIO_EXT.has(ext)) {
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
    if (rec.kind !== "image") return { asset: rec };
    const inspection = await inspectImage(this.abs(rec.file));
    return { asset: rec, inspection, view: await this.assetView(id) };
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
          name: doc.name ?? id,
          canvas: doc.canvas,
          duration: doc.duration,
          layers: (doc.layers ?? []).length,
          tracks: (doc.animations ?? []).length,
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
      ...rest,
      audio: (audio ?? []).map((a: any) => ({ assetId: byFile.get(a.src) ?? null, startFrame: a.startFrame ?? 0, volume: a.volume ?? 1 })),
      assetsUsed: Object.keys(assets ?? {}),
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

  private validateDoc(id: string, doc: ops.SceneDoc): ValidationIssue[] {
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

  async createScene(args: { sceneId?: string; name?: string; canvas?: Record<string, unknown>; duration?: number; camera?: Record<string, unknown> } = {}) {
    const id = args.sceneId ? checkEntityId("scene", args.sceneId) : this.nextFreeSceneId();
    if (this.hasScene(id)) throw new EngineError("SCENE_EXISTS", `Scene "${id}" already exists`, { sceneId: id });
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
    return { sceneId: id, warnings };
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
      // expose every image asset during the operation so references resolve; sync prunes afterwards
      const doc = this.withAllAssets(this.getSceneDoc(id));
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
    const doc = this.syncSceneAssets(this.getSceneDoc(id));
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
  async renderPreview(sceneId: string, frame: number, opts: { debug?: boolean; debugOptions?: DebugOptions } = {}) {
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
