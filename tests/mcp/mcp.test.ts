/**
 * MCP-level tests against the BUILT server (dist/video-engine-mcp.mjs) over real stdio.
 * Run with `npm run test:mcp` (builds first).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpDir, writeTestPng } from "../helpers.js";
import { McpStdioClient, SERVER } from "./client.js";

let root: string;
let lib: string;
let c: McpStdioClient;
const WS = "t1";

beforeAll(async () => {
  if (!fs.existsSync(SERVER)) throw new Error("Build the server first: npm run build:mcp");
  root = tmpDir("mcp-root-");
  lib = tmpDir("mcp-lib-");
  await writeTestPng(path.join(lib, "props", "cup_keyed.png"), 160, 140, (ctx) => {
    ctx.fillStyle = "#14a9e7";
    ctx.fillRect(0, 0, 160, 140);
    ctx.fillStyle = "#f5f5f0";
    ctx.beginPath();
    ctx.roundRect(40, 30, 70, 80, 10);
    ctx.fill();
    ctx.fillStyle = "#14a9e7";
    ctx.fillRect(55, 60, 40, 10); // enclosed key-coloured stripe
    ctx.fillStyle = "#e03020";
    ctx.fillRect(140, 120, 4, 4); // speck
  });
  await writeTestPng(path.join(lib, "bg.png"), 640, 360, (ctx) => {
    ctx.fillStyle = "#f3e6cf";
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = "#b98a5e";
    ctx.fillRect(0, 300, 640, 60);
  });
  c = new McpStdioClient({ VIDEO_ENGINE_ROOT: root, VIDEO_ENGINE_LIBRARIES: `test=${lib}` });
  await c.initialize();
}, 30_000);

afterAll(async () => {
  await c?.close();
});

describe("discovery", () => {
  it("initializes with Tandem's protocol version and lists self-contained tool schemas", async () => {
    const r = await c.rpc("tools/list", {});
    const names = r.tools.map((t: any) => t.name);
    for (const n of [
      "engine_capabilities", "engine_version", "engine_health", "workspace_create", "workspace_open", "workspace_info",
      "asset_list", "asset_get", "asset_inspect", "asset_process", "asset_trim", "asset_components", "asset_component_remove",
      "scene_create", "scene_get", "scene_list", "scene_update", "scene_delete", "layer_add", "layer_update", "layer_remove",
      "layer_list", "timeline_get", "timeline_apply", "measure_layout", "render_preview", "render_frame",
      "render_video_start", "render_video_status", "render_video_cancel",
    ]) {
      expect(names).toContain(n);
    }
    for (const t of r.tools) {
      const s = JSON.stringify(t.inputSchema);
      expect(s, t.name).not.toContain("$ref");
      expect(t.inputSchema.type, t.name).toBe("object");
      expect(`[Video Engine] ${t.description}`.length, t.name).toBeLessThanOrEqual(1024); // Tandem catalog limit
    }
  });

  it("reports capabilities derived from the engine", async () => {
    const cap = await c.ok("engine_capabilities");
    expect(cap.scene).toMatchObject({ globalZ: true, parentTransforms: true, masks: true, camera: true });
    expect(cap.animation).toMatchObject({ step: true, linear: true, easing: true });
    expect(cap.assets).toMatchObject({ transparentTrim: true, backgroundRemoval: true, componentDetection: true });
    expect(cap.render).toMatchObject({ preview: true, frame: true, video: true });
    expect(cap.server.libraries).toEqual(["test"]);
    expect((await c.ok("engine_health")).ok).toBe(true);
  });
});

describe("isolation and errors", () => {
  it("rejects bad workspace ids, traversal and host paths with structured errors", async () => {
    const bad = await c.call("workspace_create", { workspaceId: "../escape" });
    expect(bad).toMatchObject({ ok: false, data: { error: { code: "INVALID_ID" } } });
    expect((await c.call("workspace_info", { workspaceId: "nope" })).data.error.code).toBe("WORKSPACE_NOT_FOUND");
    await c.ok("workspace_create", { workspaceId: WS });
    const trav = await c.call("asset_import", { workspaceId: WS, source: { library: "test", path: "../../../../etc/passwd" } });
    expect(trav.data.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
    const inbox = await c.call("asset_import", { workspaceId: WS, source: { inbox: "../../t2/x.png" } });
    expect(inbox.data.error.code).toBe("PATH_OUTSIDE_WORKSPACE");
    const host = await c.call("asset_import", { workspaceId: WS, source: { path: "/etc/passwd" } });
    expect(host.data.error.code).toBe("INVALID_ARGUMENT");
    expect(fs.readdirSync(root).filter((d) => !d.startsWith("."))).toEqual([WS]);
  });

  it("survives unknown tools, invalid arguments and garbage input", async () => {
    expect((await c.call("does_not_exist")).data.error.code).toBe("UNKNOWN_TOOL");
    const inv = await c.call("scene_create", { workspaceId: WS, duration: -3 });
    expect(inv.data.error).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(inv.data.error.details.issues[0].path).toEqual(["duration"]);
    c.writeRaw("this is not json");
    c.writeRaw(JSON.stringify({ jsonrpc: "2.0", id: 999999, method: "nonexistent/method" }));
    const v = await c.ok("engine_version");
    expect(v.server.name).toBe("video-engine");
  });
});

describe("scene workflow", () => {
  it("imports, processes, trims and inspects assets", async () => {
    const bg = await c.ok("asset_import", { workspaceId: WS, source: { library: "test", path: "bg.png" }, assetId: "bg" });
    expect(bg.asset).toMatchObject({ assetId: "bg", width: 640, height: 360 });
    await c.ok("asset_import", { workspaceId: WS, source: { library: "test", path: "props/cup_keyed.png" }, assetId: "cup_raw" });
    const insp = await c.ok("asset_inspect", { workspaceId: WS, assetId: "cup_raw" });
    expect(insp.inspection.suggestedPath).toBe("color-key");
    expect(insp.inspection.background.detectedColorHex).toBe("#14a9e7");
    expect(fs.statSync(insp.viewPath).size).toBeLessThanOrEqual(150_000);
    const p1 = await c.ok("asset_process", { workspaceId: WS, assetId: "cup_raw", newAssetId: "cup_try" });
    expect(p1.diagnostics.components.length).toBe(2);
    expect(p1.diagnostics.holes[0].removed).toBe(false); // the enclosed stripe is kept
    const comps = await c.ok("asset_components", { workspaceId: WS, assetId: "cup_try" });
    expect(comps.components).toHaveLength(2);
    const cleaned = await c.ok("asset_component_remove", { workspaceId: WS, assetId: "cup_try", componentIds: [2], newAssetId: "cup_clean" });
    expect(cleaned.removedPixels).toBeGreaterThan(0);
    const trimmed = await c.ok("asset_trim", { workspaceId: WS, assetId: "cup_clean", newAssetId: "cup" });
    expect(trimmed.asset).toMatchObject({ width: 70, height: 80, provenance: { operation: "trim", sourceAssetId: "cup_clean" } });
    await c.ok("asset_update", { workspaceId: WS, assetId: "cup", attachmentPoints: { base: { x: 0.5, y: 1 } } });
    const list = await c.ok("asset_list", { workspaceId: WS });
    expect(list.assets.map((a: any) => a.assetId)).toEqual(["bg", "cup", "cup_clean", "cup_raw", "cup_try"]);
  });

  it("builds a scene with hierarchy, global z, animation and camera; measures and renders", async () => {
    const s = await c.ok("scene_create", { workspaceId: WS, sceneId: "kitchen", canvas: { width: 640, height: 360, fps: 10 }, duration: 30 });
    expect(s.sceneId).toBe("kitchen");
    await c.ok("layer_add", {
      workspaceId: WS,
      sceneId: "kitchen",
      layers: [
        { id: "arm", parent: "body", fill: "#3366ff", width: 16, height: 70, x: 20, y: -30, anchorX: 0.5, anchorY: 0, z: 30 },
        { id: "bg", asset: "bg", x: 320, y: 180, z: 0 },
        { id: "body", fill: "#cc3333", width: 60, height: 140, x: 300, y: 250, anchorX: 0.5, anchorY: 1, z: 10 },
        { id: "counter", fill: "#8a5a2e", width: 400, height: 90, x: 320, y: 315, z: 20 },
        { id: "cup1", asset: "cup", x: 420, y: 270, anchorY: 1, scaleX: 0.5, scaleY: 0.5, z: 25 },
        { id: "cup2", asset: "cup", x: 480, y: 270, anchorY: 1, scaleX: 0.5, scaleY: 0.5, z: 25 },
      ],
    });
    // global z independent of hierarchy: arm (child of body z10) draws above counter (z20)
    let lay = await c.ok("measure_layout", { workspaceId: WS, sceneId: "kitchen", frame: 0 });
    expect(lay.drawOrder).toEqual(["bg", "body", "counter", "cup1", "cup2", "arm"]);
    const arm0 = lay.layers.find((l: any) => l.id === "arm");
    expect(arm0.worldPivot).toEqual({ x: 320, y: 220 }); // child x/y are offsets from the parent PIVOT (300,250)
    // multi-property atomic update
    const upd = await c.ok("layer_update", { workspaceId: WS, sceneId: "kitchen", layerId: "arm", patch: { rotation: -30, y: -120 } });
    expect(upd.layers[0]).toMatchObject({ rotation: -30, y: -120 });
    // timeline batch + camera
    await c.ok("timeline_apply", {
      workspaceId: WS,
      sceneId: "kitchen",
      operations: [
        { type: "keyframe.add", target: "body", property: "x", frame: 0, value: 200 },
        { type: "keyframe.add", target: "body", property: "x", frame: 29, value: 300, interpolation: "ease-in-out" },
        { type: "keyframe.add", target: "arm", property: "rotation", frame: 0, value: -30, interpolation: "linear" },
        { type: "keyframe.add", target: "arm", property: "rotation", frame: 29, value: 20 },
        { type: "keyframe.add", target: "camera", property: "scale", frame: 0, value: 1 },
        { type: "keyframe.add", target: "camera", property: "scale", frame: 29, value: 1.2, interpolation: "ease-in-out" },
      ],
    });
    lay = await c.ok("measure_layout", { workspaceId: WS, sceneId: "kitchen", frame: 29, layers: ["body", "arm"] });
    expect(lay.layers.find((l: any) => l.id === "body").worldPivot.x).toBe(300);
    expect(lay.camera.scale).toBe(1.2);
    const tl = await c.ok("timeline_get", { workspaceId: WS, sceneId: "kitchen", target: "camera" });
    expect(tl.tracks).toHaveLength(1);
    // asset reuse
    const scene = await c.ok("scene_get", { workspaceId: WS, sceneId: "kitchen" });
    expect(scene.scene.assetsUsed.sort()).toEqual(["bg", "cup"]);
    // preview + debug preview + frame artifacts
    const prev = await c.ok("render_preview", { workspaceId: WS, sceneId: "kitchen", frame: 15 });
    expect(prev.artifact).toMatchObject({ kind: "preview", frame: 15, width: 640, height: 360, workspaceId: WS });
    expect(prev.artifact.relativePath).toMatch(/^previews\//);
    expect(fs.existsSync(prev.artifact.path)).toBe(true);
    expect(fs.statSync(prev.viewPath).size).toBeLessThanOrEqual(150_000);
    const dbg = await c.ok("render_preview", { workspaceId: WS, sceneId: "kitchen", frame: 15, debug: true, debugOptions: { only: ["arm", "body"] } });
    expect(dbg.artifact.kind).toBe("debug-preview");
    const f = await c.ok("render_frame", { workspaceId: WS, sceneId: "kitchen", frame: 15 });
    expect(f.artifact.pixelSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns machine-readable errors for invalid scene edits and leaves the scene unchanged", async () => {
    const before = await c.ok("scene_get", { workspaceId: WS, sceneId: "kitchen" });
    const cases: [string, Record<string, unknown>, string][] = [
      ["layer_update", { sceneId: "nope", layerId: "arm", patch: { x: 1 } }, "SCENE_NOT_FOUND"],
      ["layer_update", { sceneId: "kitchen", layerId: "ghost", patch: { x: 1 } }, "LAYER_NOT_FOUND"],
      ["layer_update", { sceneId: "kitchen", layerId: "arm", patch: { parent: "ghost" } }, "INVALID_PARENT"],
      ["layer_update", { sceneId: "kitchen", layerId: "body", patch: { parent: "arm" } }, "PARENT_CYCLE"],
      ["layer_update", { sceneId: "kitchen", layerId: "cup1", patch: { asset: "no_such_asset" } }, "ASSET_NOT_FOUND"],
      ["layer_update", { sceneId: "kitchen", layerId: "arm", patch: { opacity: 3 } }, "INVALID_ARGUMENT"],
      ["timeline_apply", { sceneId: "kitchen", operations: [{ type: "keyframe.add", target: "arm", property: "visible", frame: 3, value: false, interpolation: "linear" }] }, "INVALID_KEYFRAME"],
      ["timeline_apply", { sceneId: "kitchen", operations: [{ type: "keyframe.add", target: "arm", property: "skew", frame: 3, value: 1 }] }, "UNSUPPORTED_PROPERTY"],
      ["timeline_apply", { sceneId: "kitchen", operations: [{ type: "keyframe.add", target: "ghost", property: "x", frame: 3, value: 1 }] }, "LAYER_NOT_FOUND"],
      ["measure_layout", { sceneId: "kitchen", frame: 30 }, "INVALID_FRAME"],
      ["render_preview", { sceneId: "kitchen", frame: 1.5 }, "INVALID_ARGUMENT"],
    ];
    for (const [tool, args, code] of cases) {
      const r = await c.call(tool, { workspaceId: WS, ...args });
      expect(r.ok, `${tool} ${JSON.stringify(args)}`).toBe(false);
      expect(r.data.error.code, `${tool} ${JSON.stringify(args)} -> ${r.text}`).toBe(code);
      expect(typeof r.data.error.message).toBe("string");
    }
    // partial multi-layer update is rejected as a whole
    const multi = await c.call("layer_update", {
      workspaceId: WS,
      sceneId: "kitchen",
      updates: [{ layerId: "body", patch: { x: 10 } }, { layerId: "ghost", patch: { x: 5 } }],
    });
    expect(multi.data.error.code).toBe("LAYER_NOT_FOUND");
    expect(multi.data.error.details.issues[0].details).toMatchObject({ layerId: "ghost", updateIndex: 1 });
    const after = await c.ok("scene_get", { workspaceId: WS, sceneId: "kitchen" });
    expect(after.scene).toEqual(before.scene);
  });

  it("renders a video as a job with progress, completion artifact, cancellation and failure reporting", async () => {
    const start = await c.ok("render_video_start", { workspaceId: WS, sceneId: "kitchen" });
    expect(start).toMatchObject({ status: "queued", totalFrames: 30 });
    const done = await c.ok("render_video_status", { workspaceId: WS, renderId: start.renderId, waitSeconds: 40 });
    expect(done).toMatchObject({ status: "completed", progress: 1, durationSeconds: 3 });
    expect(done.relativePath).toMatch(/^renders\/.*\.mp4$/);
    expect(fs.statSync(done.artifact.path).size).toBeGreaterThan(1000);

    await c.ok("scene_create", { workspaceId: WS, sceneId: "long", canvas: { width: 1280, height: 720, fps: 30 }, duration: 900 });
    await c.ok("layer_add", { workspaceId: WS, sceneId: "long", layers: [{ id: "bg", asset: "bg", x: 640, y: 360, scaleX: 2, scaleY: 2 }] });
    const long = await c.ok("render_video_start", { workspaceId: WS, sceneId: "long" });
    await new Promise((r) => setTimeout(r, 1500));
    const mid = await c.ok("render_video_status", { workspaceId: WS, renderId: long.renderId });
    expect(mid.status).toBe("running");
    expect(mid.frame).toBeGreaterThan(0);
    expect(mid.progress).toBeGreaterThan(0);
    await c.ok("render_video_cancel", { workspaceId: WS, renderId: long.renderId });
    const cancelled = await c.ok("render_video_status", { workspaceId: WS, renderId: long.renderId, waitSeconds: 10 });
    expect(cancelled).toMatchObject({ status: "cancelled", error: { code: "RENDER_CANCELLED" } });

    // failed render: the scene's asset file disappears after the job was accepted
    fs.rmSync(path.join(root, WS, "assets", "bg", "bg.png"));
    const bad = await c.call("render_video_start", { workspaceId: WS, sceneId: "kitchen" });
    expect(bad.data.error.code).toBe("ASSET_NOT_FOUND");
    expect((await c.call("render_video_status", { workspaceId: WS, renderId: "render_999" })).data.error.code).toBe("RENDER_NOT_FOUND");
  }, 60_000);

  it("logs every call to the JSONL log, never to stdout", async () => {
    const log = fs.readFileSync(path.join(root, ".logs", "mcp.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const calls = log.filter((e) => e.tool);
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.some((e) => e.tool === "render_preview" && e.ok && e.artifacts?.length)).toBe(true);
    expect(calls.some((e) => e.errorCode === "PARENT_CYCLE")).toBe(true);
    expect(calls.every((e) => typeof e.durationMs === "number")).toBe(true);
  });
});

describe("assigned workspace", () => {
  it("a server locked to one workspace refuses every other workspace", async () => {
    const r2 = tmpDir("mcp-root2-");
    const locked = new McpStdioClient({ VIDEO_ENGINE_ROOT: r2, VIDEO_ENGINE_WORKSPACE: "assigned" });
    await locked.initialize();
    expect((await locked.call("workspace_create", { workspaceId: "other" })).data.error.code).toBe("WORKSPACE_FORBIDDEN");
    await locked.ok("workspace_open", { workspaceId: "assigned", create: true });
    expect((await locked.ok("workspace_list")).workspaces.map((w: any) => w.workspaceId)).toEqual(["assigned"]);
    await locked.close();
  });
});
