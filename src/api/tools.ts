/**
 * Agent-facing tool layer. Every capability of the engine is reachable through
 *
 *     session.call(toolName, args) -> { ok: true, result } | { ok: false, errors: [...] }
 *
 * with plain-JSON arguments and results, so it can be exposed 1:1 as MCP / function-calling
 * tools later (see `toolDefinitions()` which emits JSON Schemas). Errors are never thrown to the
 * caller; they come back as machine-readable issues.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readRgba, writePng } from "../assets/image.js";
import { findComponents, removeComponents } from "../assets/components.js";
import { processAsset } from "../assets/pipeline.js";
import { trimTransparent } from "../assets/trim.js";
import { SceneValidationError, validateScene, type ValidationIssue } from "../scene/validate.js";
import { AnimationEngine } from "./engine.js";
import * as ops from "./operations.js";

const Json = z.record(z.string(), z.unknown());
const Frame = z.number().int().min(0);

export const TOOLS = {
  create_scene: {
    description: "Create a new empty scene document (replaces the session's current scene).",
    args: z.object({
      name: z.string().optional(),
      canvas: z.object({ width: z.number().optional(), height: z.number().optional(), fps: z.number().optional(), background: z.string().optional() }).optional(),
      duration: z.number().int().optional(),
      baseDir: z.string().optional().describe("Directory that relative asset paths resolve against"),
    }),
  },
  load_scene: { description: "Load a scene JSON file.", args: z.object({ path: z.string() }) },
  save_scene: { description: "Write the current scene JSON to disk.", args: z.object({ path: z.string().optional() }) },
  get_scene: { description: "Return the current scene document.", args: z.object({}) },
  validate_scene: { description: "Validate the scene (schema, references, cycles, keyframes, files).", args: z.object({}) },
  set_asset: {
    description: "Register or replace an image asset: { src, attachmentPoints? }.",
    args: z.object({ id: z.string(), asset: Json }),
  },
  remove_asset: { description: "Remove an asset entry.", args: z.object({ id: z.string() }) },
  add_layer: { description: "Add a layer. `index` only affects z tie-breaking.", args: z.object({ layer: Json, index: z.number().int().optional() }) },
  update_layer: {
    description: "Shallow-merge a patch into a layer (null removes a key, restoring its default).",
    args: z.object({ id: z.string(), patch: Json }),
  },
  remove_layer: {
    description: "Remove a layer; children: error | cascade | reparent.",
    args: z.object({ id: z.string(), children: z.enum(["error", "cascade", "reparent"]).optional() }),
  },
  set_parent: {
    description: "Set/clear a layer's transform parent (and optional parent attachment point). Does not change z.",
    args: z.object({ id: z.string(), parent: z.string().nullable(), parentPoint: z.string().nullable().optional() }),
  },
  set_camera: { description: "Patch the static camera {x, y, scale, rotation}.", args: Json },
  set_scene_props: {
    description: "Patch duration, name or canvas settings.",
    args: z.object({ duration: z.number().int().optional(), name: z.string().optional(), canvas: Json.optional() }),
  },
  add_keyframe: {
    description: "Insert (or replace at same frame) a keyframe on target.property. target = layer id or 'camera'.",
    args: z.object({ target: z.string(), property: z.string(), keyframe: Json }),
  },
  update_keyframe: {
    description: "Patch the keyframe at `frame` of target.property.",
    args: z.object({ target: z.string(), property: z.string(), frame: Frame, patch: Json }),
  },
  remove_keyframe: {
    description: "Remove the keyframe at `frame`. Removing the last keyframe removes the track.",
    args: z.object({ target: z.string(), property: z.string(), frame: Frame }),
  },
  set_track: { description: "Replace/create a whole animation track {target, property, keyframes}.", args: Json },
  process_asset_background: {
    description:
      "Non-destructively process an image: native alpha or border-detected solid-colour key (flood fill + despill), components, trim. Optionally register it as a scene asset.",
    args: z.object({
      input: z.string(),
      outDir: z.string(),
      options: Json.optional(),
      registerAs: z.string().optional().describe("Asset id to register processed-transparent.png under"),
    }),
  },
  trim_transparent: {
    description: "Crop an RGBA image to its visible pixels (+padding). Writes a new file.",
    args: z.object({ input: z.string(), output: z.string(), alphaThreshold: z.number().optional(), padding: z.number().optional() }),
  },
  find_components: {
    description: "List disconnected visible components (8-connected alpha) of an image. id 1 = largest.",
    args: z.object({ input: z.string(), alphaThreshold: z.number().optional() }),
  },
  remove_component: {
    description: "Write a copy of an image with the given component ids made transparent.",
    args: z.object({ input: z.string(), output: z.string(), ids: z.array(z.number().int()), alphaThreshold: z.number().optional() }),
  },
  render_preview: { description: "Render one frame to a PNG.", args: z.object({ frame: Frame, out: z.string() }) },
  render_debug_preview: {
    description: "Render one frame with bounds/ids/pivots/centres/z/attachment points overlaid.",
    args: z.object({ frame: Frame, out: z.string(), options: Json.optional() }),
  },
  measure_layout: {
    description: "World/screen geometry of layers at a frame (bounds, centre, pivot, corners, attachment points, draw order).",
    args: z.object({ frame: Frame, layers: z.array(z.string()).optional() }),
  },
  render_frame: {
    description: "Render one frame; returns size and sha256 of the RGBA pixels, optionally writing a PNG.",
    args: z.object({ frame: Frame, out: z.string().optional() }),
  },
  render_video: {
    description: "Render frames [startFrame, endFrame) to an H.264 MP4 via an FFmpeg pipe (with scene audio).",
    args: z.object({ out: z.string(), startFrame: Frame.optional(), endFrame: Frame.optional(), crf: z.number().optional(), audio: z.boolean().optional() }),
  },
} as const;

export type ToolName = keyof typeof TOOLS;

export type ToolResult = { ok: true; result: unknown; warnings?: ValidationIssue[] } | { ok: false; errors: ValidationIssue[] };

export function toolDefinitions() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.args as z.ZodType),
  }));
}

const fail = (code: string, message: string, p: (string | number)[] = []): ToolResult => ({
  ok: false,
  errors: [{ severity: "error", code, path: p, message }],
});

export class EngineSession {
  doc: ops.SceneDoc | null = null;
  baseDir: string = process.cwd();
  file: string | null = null;
  private engine: AnimationEngine | null = null;
  private engineDocVersion = -1;
  private docVersion = 0;

  private setDoc(doc: ops.SceneDoc) {
    this.doc = doc;
    this.docVersion++;
  }

  private resolvePath(p: string) {
    return path.isAbsolute(p) ? p : path.join(this.baseDir, p);
  }

  private async prepared(): Promise<AnimationEngine> {
    if (!this.doc) throw new SceneValidationError([{ severity: "error", code: "NO_SCENE", path: [], message: "No scene loaded" }]);
    if (!this.engine || this.engine.baseDir !== this.baseDir) this.engine = new AnimationEngine(this.doc, this.baseDir);
    if (this.engineDocVersion !== this.docVersion) {
      this.engine.setDocument(this.doc);
      await this.engine.prepare();
      this.engineDocVersion = this.docVersion;
    }
    return this.engine;
  }

  private edit(r: ops.OpResult<unknown>): ToolResult {
    if (!r.ok) return r;
    this.setDoc(r.scene);
    return { ok: true, result: r.result ?? null, warnings: r.warnings };
  }

  async call(name: string, rawArgs: unknown = {}): Promise<ToolResult> {
    const tool = (TOOLS as Record<string, { args: z.ZodType }>)[name];
    if (!tool) return fail("UNKNOWN_TOOL", `Unknown tool "${name}". Available: ${Object.keys(TOOLS).join(", ")}`);
    const parsed = tool.args.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((i) => ({ severity: "error", code: "INVALID_ARGUMENT", path: i.path.map(String), message: i.message })),
      };
    }
    try {
      return await this.run(name as ToolName, parsed.data as any);
    } catch (e) {
      if (e instanceof SceneValidationError) return { ok: false, errors: e.issues };
      return fail(e instanceof RangeError ? "OUT_OF_RANGE" : "INTERNAL_ERROR", (e as Error).message);
    }
  }

  private needDoc(): ops.SceneDoc {
    if (!this.doc) throw new SceneValidationError([{ severity: "error", code: "NO_SCENE", path: [], message: "No scene loaded; call create_scene or load_scene" }]);
    return this.doc;
  }

  private async run(name: ToolName, a: any): Promise<ToolResult> {
    switch (name) {
      case "create_scene": {
        const r = ops.createScene(a);
        if (!r.ok) return r;
        if (a.baseDir) this.baseDir = path.resolve(a.baseDir);
        this.file = null;
        return this.edit(r);
      }
      case "load_scene": {
        const file = path.resolve(a.path);
        let doc: unknown;
        try {
          doc = JSON.parse(await fs.readFile(file, "utf8"));
        } catch (e) {
          return fail("INVALID_JSON", (e as Error).message, ["path"]);
        }
        this.baseDir = path.dirname(file);
        this.file = file;
        this.setDoc(doc as ops.SceneDoc);
        const v = validateScene(doc, { baseDir: this.baseDir });
        return { ok: true, result: { file, valid: v.ok, errors: v.errors }, warnings: v.warnings };
      }
      case "save_scene": {
        const doc = this.needDoc();
        const file = a.path ? path.resolve(a.path) : this.file;
        if (!file) return fail("NO_PATH", "No path given and scene was not loaded from a file", ["path"]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(doc, null, 2) + "\n");
        this.file = file;
        return { ok: true, result: { file } };
      }
      case "get_scene":
        return { ok: true, result: this.needDoc() };
      case "validate_scene": {
        const v = validateScene(this.needDoc(), { baseDir: this.baseDir });
        return v.ok ? { ok: true, result: { valid: true }, warnings: v.warnings } : { ok: false, errors: [...v.errors, ...v.warnings] };
      }
      case "set_asset":
        return this.edit(ops.setAsset(this.needDoc(), a.id, a.asset));
      case "remove_asset":
        return this.edit(ops.removeAsset(this.needDoc(), a.id));
      case "add_layer":
        return this.edit(ops.addLayer(this.needDoc(), a));
      case "update_layer":
        return this.edit(ops.updateLayer(this.needDoc(), a.id, a.patch));
      case "remove_layer":
        return this.edit(ops.removeLayer(this.needDoc(), a));
      case "set_parent":
        return this.edit(ops.setParent(this.needDoc(), a));
      case "set_camera":
        return this.edit(ops.setCamera(this.needDoc(), a));
      case "set_scene_props":
        return this.edit(ops.setSceneProps(this.needDoc(), a));
      case "add_keyframe":
        return this.edit(ops.addKeyframe(this.needDoc(), a));
      case "update_keyframe":
        return this.edit(ops.updateKeyframe(this.needDoc(), a));
      case "remove_keyframe":
        return this.edit(ops.removeKeyframe(this.needDoc(), a));
      case "set_track":
        return this.edit(ops.setTrack(this.needDoc(), a));
      case "process_asset_background": {
        const outDir = this.resolvePath(a.outDir);
        const meta = await processAsset(this.resolvePath(a.input), outDir, a.options ?? {});
        if (!meta.ok) return { ok: false, errors: meta.issues.map((i) => ({ ...i, path: ["input"] })) };
        if (a.registerAs) {
          const src = path.relative(this.baseDir, path.join(outDir, meta.files.processed));
          const asset: Record<string, unknown> = { src };
          if (meta.attachmentPoints) asset.attachmentPoints = meta.attachmentPoints;
          const r = this.edit(ops.setAsset(this.needDoc(), a.registerAs, asset));
          if (!r.ok) return r;
        }
        return { ok: true, result: meta };
      }
      case "trim_transparent": {
        const input = this.resolvePath(a.input);
        const output = this.resolvePath(a.output);
        if (path.resolve(input) === path.resolve(output)) return fail("WOULD_OVERWRITE", "output must differ from input (non-destructive)", ["output"]);
        const { image } = await readRgba(input);
        const r = trimTransparent(image, { alphaThreshold: a.alphaThreshold, padding: a.padding });
        await writePng(r.image, output);
        return { ok: true, result: { output, ...r.info } };
      }
      case "find_components": {
        const { image } = await readRgba(this.resolvePath(a.input));
        return { ok: true, result: { components: findComponents(image, a.alphaThreshold ?? 8).components } };
      }
      case "remove_component": {
        const input = this.resolvePath(a.input);
        const output = this.resolvePath(a.output);
        if (path.resolve(input) === path.resolve(output)) return fail("WOULD_OVERWRITE", "output must differ from input (non-destructive)", ["output"]);
        const { image } = await readRgba(input);
        const r = removeComponents(image, a.ids, a.alphaThreshold ?? 8);
        await writePng(r.image, output);
        return { ok: true, result: { output, removedPixels: r.removedPixels } };
      }
      case "render_preview": {
        const e = await this.prepared();
        return { ok: true, result: { file: await e.renderPreview(a.frame, this.resolvePath(a.out)) } };
      }
      case "render_debug_preview": {
        const e = await this.prepared();
        return { ok: true, result: { file: await e.renderDebugPreview(a.frame, this.resolvePath(a.out), a.options) } };
      }
      case "measure_layout": {
        const e = await this.prepared();
        const layout = e.measureLayout(a.frame);
        if (a.layers) {
          const want = new Set<string>(a.layers);
          const missing = [...want].filter((id) => !layout.layers.some((l) => l.id === id));
          if (missing.length) return fail("MISSING_LAYER", `Unknown layer(s): ${missing.join(", ")}`, ["layers"]);
          layout.layers = layout.layers.filter((l) => want.has(l.id));
        }
        return { ok: true, result: layout };
      }
      case "render_frame": {
        const e = await this.prepared();
        const f = await e.renderFrame(a.frame);
        const { createHash } = await import("node:crypto");
        const sha256 = createHash("sha256").update(f.rgba()).digest("hex");
        let file: string | undefined;
        if (a.out) {
          file = this.resolvePath(a.out);
          await fs.mkdir(path.dirname(file), { recursive: true });
          await fs.writeFile(file, await f.png());
        }
        return { ok: true, result: { frame: a.frame, width: f.width, height: f.height, sha256, file } };
      }
      case "render_video": {
        const e = await this.prepared();
        const r = await e.renderVideo(this.resolvePath(a.out), a);
        return { ok: true, result: r };
      }
    }
  }
}
