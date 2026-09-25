import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as ops from "../src/api/operations.js";
import { engineCapabilities } from "../src/capabilities.js";
import { RenderJobs } from "../src/workspace/jobs.js";
import { WorkspaceManager } from "../src/workspace/workspace.js";
import { tmpDir, writeTestPng } from "./helpers.js";

async function setup(opts: { locked?: string } = {}) {
  const root = tmpDir("ws-root-");
  const lib = tmpDir("ws-lib-");
  await writeTestPng(path.join(lib, "props", "cup_keyed.png"), 120, 100, (ctx) => {
    ctx.fillStyle = "#14a9e7";
    ctx.fillRect(0, 0, 120, 100);
    ctx.fillStyle = "#f5f5f0";
    ctx.fillRect(30, 20, 60, 60);
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(104, 88, 3, 3);
  });
  await writeTestPng(path.join(lib, "bg.png"), 320, 180, (ctx) => {
    ctx.fillStyle = "#335577";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#eecc88";
    ctx.fillRect(0, 120, 320, 60);
  });
  await writeTestPng(path.join(lib, "arm.png"), 40, 60, (ctx) => {
    ctx.fillStyle = "#cc8866";
    ctx.fillRect(10, 5, 20, 50);
  });
  const mgr = new WorkspaceManager({ root, libraries: { test: lib }, lockedWorkspace: opts.locked });
  return { root, lib, mgr };
}

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e: any) {
    return e.code;
  }
  return "NO_ERROR";
};

describe("workspace isolation", () => {
  it("rejects invalid workspace ids and traversal", async () => {
    const { mgr } = await setup();
    for (const bad of ["../x", "A", "", "a/b", "..", "x".repeat(70)]) expect(await code(() => mgr.create(bad))).toBe("INVALID_ID");
    expect(await code(() => mgr.open("nope"))).toBe("WORKSPACE_NOT_FOUND");
    const ws = mgr.create("w1");
    expect(await code(() => ws.abs("../w2/x"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(await code(() => ws.abs("/etc/passwd"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(await code(() => mgr.resolveLibraryFile("test", "../../etc/passwd"))).toBe("PATH_OUTSIDE_WORKSPACE");
    expect(await code(() => mgr.resolveLibraryFile("nolib", "a.png"))).toBe("LIBRARY_NOT_FOUND");
  });

  it("rejects symlinks that escape the workspace", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    const outside = tmpDir("outside-");
    fs.writeFileSync(path.join(outside, "secret.png"), "x");
    fs.symlinkSync(outside, path.join(ws.dir, "inbox", "link"));
    expect(await code(() => ws.abs("inbox/link/secret.png"))).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("a locked server only serves its assigned workspace", async () => {
    const { mgr } = await setup({ locked: "only" });
    expect(await code(() => mgr.create("other"))).toBe("WORKSPACE_FORBIDDEN");
    mgr.create("only");
    expect(mgr.list().map((w) => w.workspaceId)).toEqual(["only"]);
  });
});

describe("assets", () => {
  it("imports from a library by relative path, dedupes identical content, keeps stable ids", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    const file = mgr.resolveLibraryFile("test", "props/cup_keyed.png");
    const a = await ws.importAsset({ kind: "file", file, origin: { library: "test", path: "props/cup_keyed.png" } });
    expect(a.reused).toBe(false);
    expect(a.asset).toMatchObject({ assetId: "cup_keyed", kind: "image", width: 120, height: 100 });
    const again = await ws.importAsset({ kind: "file", file, origin: {} });
    expect(again).toMatchObject({ reused: true, asset: { assetId: "cup_keyed" } });
    expect(ws.listAssets()).toHaveLength(1);
    expect(await code(ws.importAsset({ kind: "bytes", data: Buffer.from("x"), filename: "a.txt", origin: {} }))).toBe("INVALID_ASSET");
    expect(await code(ws.importAsset({ kind: "bytes", data: Buffer.from("not a png"), filename: "a.png", origin: {} }))).toBe("INVALID_ASSET");
    expect(fs.existsSync(path.join(ws.dir, "assets", "a"))).toBe(false); // failed import cleaned up
    expect(await code(() => ws.getAsset("ghost"))).toBe("ASSET_NOT_FOUND");
  });

  it("processes a keyed image into a NEW trimmed transparent asset, source untouched", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    const { asset } = await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "props/cup_keyed.png"), origin: {} });
    const before = fs.readFileSync(ws.assetFile(asset.assetId));
    const insp = await ws.inspectAsset(asset.assetId);
    expect(insp.inspection).toMatchObject({ suggestedPath: "color-key", background: { detectedColorHex: "#14a9e7" } });
    expect(insp.view!.bytes).toBeLessThanOrEqual(140_000);
    const comps = await ws.assetComponents(asset.assetId);
    expect(comps).toHaveLength(1); // opaque image = one big component
    const p = await ws.processAsset(asset.assetId, { removeComponents: [2], trim: { padding: 0 } });
    expect(p.asset).toMatchObject({ assetId: "cup_keyed_processed", hasAlpha: true, width: 60, height: 60, provenance: { operation: "process", sourceAssetId: "cup_keyed" } });
    expect((p.diagnostics as any).detection.detectedColorHex).toBe("#14a9e7");
    expect(fs.readFileSync(ws.assetFile(asset.assetId)).equals(before)).toBe(true);
    // trim + components on a transparent asset
    const arm = await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "arm.png"), origin: {} });
    ws.updateAsset(arm.asset.assetId, { attachmentPoints: { hand: { x: 0.5, y: 55 / 60 } } });
    const t = await ws.trimAsset(arm.asset.assetId, { padding: 0 });
    expect(t.asset).toMatchObject({ width: 20, height: 50, attachmentPoints: { hand: { x: 0.5, y: 1 } } });
  });

  it("refuses to process a contract-violating background unless forced", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    const { asset } = await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "bg.png"), origin: {} });
    expect(await code(ws.processAsset(asset.assetId))).toBe("PROCESSING_FAILED");
    expect(ws.listAssets().map((a) => a.assetId)).toEqual(["bg"]);
  });
});

describe("scenes", () => {
  async function sceneWs() {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "bg.png"), origin: {} });
    await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "arm.png"), origin: {} });
    await ws.createScene({ sceneId: "s1", canvas: { width: 320, height: 180, fps: 10 }, duration: 10 });
    return ws;
  }

  it("creates, mutates atomically and reports stable error codes", async () => {
    const ws = await sceneWs();
    expect(await code(ws.createScene({ sceneId: "s1" }))).toBe("SCENE_EXISTS");
    expect(await code(() => ws.getSceneDoc("zzz"))).toBe("SCENE_NOT_FOUND");
    await ws.mutateScene("s1", (d) =>
      ops.addLayers(d, [
        { id: "arm", asset: "arm", parent: "body", x: 10, z: 30 }, // child before parent in one batch
        { id: "body", fill: "#ffffff", width: 40, height: 60, x: 160, y: 90, z: 10 },
        { id: "bg", asset: "bg", x: 160, y: 90, z: 0 },
      ]),
    );
    const before = fs.readFileSync(path.join(ws.dir, "scenes", "s1.json"), "utf8");
    expect(await code(ws.mutateScene("s1", (d) => ops.updateLayer(d, "arm", { parent: "ghost" })))).toBe("INVALID_PARENT");
    expect(await code(ws.mutateScene("s1", (d) => ops.updateLayer(d, "body", { parent: "arm" })))).toBe("PARENT_CYCLE");
    expect(await code(ws.mutateScene("s1", (d) => ops.updateLayer(d, "nope", { x: 1 })))).toBe("LAYER_NOT_FOUND");
    expect(await code(ws.mutateScene("s1", (d) => ops.updateLayer(d, "arm", { asset: "missing" })))).toBe("ASSET_NOT_FOUND");
    expect(await code(ws.mutateScene("s1", (d) => ops.updateLayer(d, "arm", { rotaton: 3 })))).toBe("UNSUPPORTED_PROPERTY");
    expect(fs.readFileSync(path.join(ws.dir, "scenes", "s1.json"), "utf8")).toBe(before);
    const view = ws.sceneView("s1");
    expect(view.assetsUsed.sort()).toEqual(["arm", "bg"]);
    expect((view as any).assets).toBeUndefined();
  });

  it("applies timeline batches atomically and names the failing operation", async () => {
    const ws = await sceneWs();
    await ws.mutateScene("s1", (d) => ops.addLayers(d, [{ id: "body", fill: "#fff", width: 10, height: 10 }]));
    const before = fs.readFileSync(path.join(ws.dir, "scenes", "s1.json"), "utf8");
    const err: any = await ws
      .mutateScene("s1", (d) =>
        ops.applyTimelineOps(d, [
          { type: "keyframe.add", target: "body", property: "x", frame: 0, value: 10 },
          { type: "keyframe.add", target: "body", property: "visible", frame: 3, value: false, interpolation: "linear" },
        ]),
      )
      .catch((e) => e);
    expect(err.code).toBe("INVALID_KEYFRAME");
    expect(err.details.issues[0]).toMatchObject({ code: "INVALID_INTERPOLATION", details: { opIndex: 1 } });
    expect(fs.readFileSync(path.join(ws.dir, "scenes", "s1.json"), "utf8")).toBe(before);
    const ok = await ws.mutateScene("s1", (d) =>
      ops.applyTimelineOps(d, [
        { type: "keyframe.add", target: "body", property: "x", frame: 0, value: 10 },
        { type: "keyframe.add", target: "body", property: "x", frame: 9, value: 90, interpolation: "ease-in-out" },
        { type: "keyframe.add", target: "camera", property: "scale", frame: 0, value: 1 },
        { type: "keyframe.add", target: "camera", property: "scale", frame: 9, value: 1.5 },
      ]),
    );
    expect(ok.result).toEqual({ applied: 4 });
    const layout = await ws.measureLayout("s1", 9, ["body"]);
    expect(layout.layers.map((l) => l.id)).toEqual(["body"]);
    expect(layout.layers[0].worldPivot.x).toBe(90);
    expect(layout.camera.scale).toBe(1.5);
    expect(await code(ws.measureLayout("s1", 10))).toBe("INVALID_FRAME");
    expect(await code(ws.measureLayout("s1", 0, ["ghost"]))).toBe("LAYER_NOT_FOUND");
  });

  it("reuses one asset across layers and scenes without copying it", async () => {
    const ws = await sceneWs();
    await ws.createScene({ sceneId: "s2", canvas: { width: 320, height: 180, fps: 10 }, duration: 5 });
    await ws.mutateScene("s1", (d) => ops.addLayers(d, [{ id: "a1", asset: "arm" }, { id: "a2", asset: "arm", x: 50 }]));
    await ws.mutateScene("s2", (d) => ops.addLayers(d, [{ id: "a3", asset: "arm" }]));
    const s1 = ws.getSceneDoc("s1");
    const s2 = ws.getSceneDoc("s2");
    expect(s1.assets.arm.src).toBe(s2.assets.arm.src);
    expect(fs.readdirSync(path.join(ws.dir, "assets"))).toEqual(["arm", "bg"]);
  });

  it("renders preview/debug/frame artifacts with small view images, deterministically", async () => {
    const ws = await sceneWs();
    await ws.mutateScene("s1", (d) => ops.addLayers(d, [{ id: "bg", asset: "bg", x: 160, y: 90 }, { id: "arm", asset: "arm", x: 160, y: 90, z: 5 }]));
    const p = await ws.renderPreview("s1", 3);
    expect(p).toMatchObject({ kind: "preview", sceneId: "s1", frame: 3, width: 320, height: 180 });
    expect(fs.existsSync(path.join(ws.dir, p.relativePath))).toBe(true);
    expect(p.view!.bytes).toBeLessThanOrEqual(140_000);
    const d = await ws.renderPreview("s1", 3, { debug: true });
    expect(d.kind).toBe("debug-preview");
    const f1 = await ws.renderFrame("s1", 4);
    const f2 = await ws.renderFrame("s1", 4);
    expect(f1.pixelSha256).toBe(f2.pixelSha256);
    expect(f1.artifactId).not.toBe(f2.artifactId);
    expect(ws.listArtifacts({ sceneId: "s1" })).toHaveLength(4);
    expect(await code(ws.renderPreview("s1", 99))).toBe("INVALID_FRAME");
  });
});

describe("engine cache", () => {
  // Regression: the prepared engine was cached by scene document only, so a deleted asset file
  // still rendered from stale in-memory bytes instead of reporting ASSET_NOT_FOUND.
  it("notices changed or deleted asset files", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    await ws.importAsset({ kind: "file", file: mgr.resolveLibraryFile("test", "arm.png"), origin: {} });
    await ws.createScene({ sceneId: "s1", canvas: { width: 64, height: 64, fps: 10 }, duration: 3 });
    await ws.mutateScene("s1", (d) => ops.addLayers(d, [{ id: "arm", asset: "arm", x: 32, y: 32 }]));
    await ws.renderPreview("s1", 0);
    fs.rmSync(ws.assetFile("arm"));
    expect(await code(ws.renderPreview("s1", 0))).toBe("ASSET_NOT_FOUND");
  });
});

describe("render jobs", () => {
  it("runs, reports progress, completes with an artifact; cancel and interruption are reported", async () => {
    const { mgr } = await setup();
    const ws = mgr.create("w1");
    await ws.createScene({ sceneId: "s1", canvas: { width: 160, height: 90, fps: 30 }, duration: 60 });
    await ws.mutateScene("s1", (d) => ops.addLayers(d, [{ id: "box", fill: "#ff0000", width: 20, height: 20, x: 80, y: 45 }]));
    const jobs = new RenderJobs(ws);
    const j = await jobs.start("s1");
    expect(j).toMatchObject({ status: "queued", totalFrames: 60 });
    const done = await jobs.wait(j.renderId, 30_000);
    expect(done).toMatchObject({ status: "completed", progress: 1, frame: 60, artifact: { kind: "video", durationSeconds: 2 } });
    expect(fs.existsSync(path.join(ws.dir, done.artifact!.relativePath))).toBe(true);

    await ws.createScene({ sceneId: "long", canvas: { width: 640, height: 360, fps: 30 }, duration: 600 });
    await ws.mutateScene("long", (d) => ops.addLayers(d, [{ id: "box", fill: "#00ff00", width: 20, height: 20, x: 80, y: 45 }]));
    const long = await jobs.start("long");
    await new Promise((r) => setTimeout(r, 400));
    const cancelled = jobs.cancel(long.renderId);
    expect(["running", "cancelled", "queued"]).toContain(cancelled.status);
    const after = await jobs.wait(long.renderId, 10_000);
    expect(after.status).toBe("cancelled");
    expect(after.error?.code).toBe("RENDER_CANCELLED");
    expect(fs.readdirSync(path.join(ws.dir, "renders")).filter((f) => f.startsWith("long_"))).toEqual([]); // partial file removed

    expect(await code(jobs.start("s1", { startFrame: 50, endFrame: 70 }))).toBe("INVALID_FRAME");
    expect(await code(async () => jobs.get("render_999"))).toBe("RENDER_NOT_FOUND");

    // a job left "running" by a dead process is reported as interrupted
    const stale = { ...done, renderId: "render_77", status: "running", artifact: undefined, pid: 1 };
    fs.writeFileSync(path.join(ws.dir, "jobs", "render_77.json"), JSON.stringify(stale));
    const fresh = new RenderJobs(ws);
    expect(fresh.get("render_77")).toMatchObject({ status: "interrupted", error: { code: "RENDER_INTERRUPTED" } });
  }, 60_000);
});

describe("capabilities", () => {
  it("are derived from the engine tables", () => {
    const c = engineCapabilities();
    expect(c.scene).toMatchObject({ globalZ: true, parentTransforms: true, masks: true, camera: true, maskTypes: ["layer", "rect"] });
    expect(c.animation).toMatchObject({ step: true, linear: true, easing: true });
    expect(c.animation.interpolations).toContain("cubic-bezier");
    expect(Object.keys(c.animation.layerProperties)).toContain("rotation");
    expect(c.assets).toMatchObject({ transparentTrim: true, backgroundRemoval: true, componentDetection: true });
    expect(c.render).toMatchObject({ preview: true, frame: true, video: true });
  });
});
