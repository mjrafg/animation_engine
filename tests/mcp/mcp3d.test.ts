/**
 * 3D over MCP (built server, real stdio), the way an agent drives it: import models from a
 * library, build a 3D scene with object_add / scene_settings_3d / timeline_apply, measure,
 * preview, render, and get structured errors. Blender-dependent steps are skipped without Blender.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blenderInfo } from "../../src/scene3d/blender.js";
import { tmpDir } from "../helpers.js";
import { McpStdioClient, SERVER } from "./client.js";

const ASSETS = path.resolve(__dirname, "..", "..", "assets", "3d");
const HAS_BLENDER = blenderInfo().available;
const WS = "w3d";
let c: McpStdioClient;

beforeAll(async () => {
  if (!fs.existsSync(SERVER)) throw new Error("Build the server first: npm run build:mcp");
  c = new McpStdioClient({ VIDEO_ENGINE_ROOT: tmpDir("mcp3d-"), VIDEO_ENGINE_LIBRARIES: `models=${ASSETS}` });
  await c.initialize();
  await c.call("workspace_create", { workspaceId: WS });
}, 30_000);

afterAll(async () => {
  await c?.close();
});

const ok = async (tool: string, args: Record<string, unknown>) => {
  const r = await c.call(tool, { workspaceId: WS, ...args });
  expect(r.ok, `${tool}: ${r.text.slice(0, 800)}`).toBe(true);
  return r.data;
};
const err = async (tool: string, args: Record<string, unknown>) => {
  const r = await c.call(tool, { workspaceId: WS, ...args });
  expect(r.ok, `${tool} should fail`).toBe(false);
  return r.data.error as { code: string; message: string; details: any };
};

describe("3D over MCP", () => {
  it("lists 3D tools and capabilities", async () => {
    const names = (await c.rpc("tools/list", {})).tools.map((t: any) => t.name);
    for (const n of ["object_add", "object_update", "object_remove", "object_list", "scene_settings_3d"]) expect(names).toContain(n);
    const caps = (await c.call("engine_capabilities")).data;
    expect(caps.threeD.coordinateSystem.axes).toMatch(/\+y up/);
    expect(caps.threeD.animation.objectProperties).toHaveProperty("clip");
    expect(caps.threeD.available).toBe(HAS_BLENDER);
  });

  it("imports and describes models", async () => {
    const lib = (await c.call("library_list", { library: "models" })).data;
    expect(lib.files.map((f: any) => f.path)).toContain("character.glb");
    const imp = await ok("asset_import", { source: { library: "models", path: "character.glb" }, assetId: "mika" });
    expect(imp.asset.kind).toBe("model");
    expect(imp.asset.model.clips.map((x: any) => x.name)).toEqual(expect.arrayContaining(["idle", "walk", "wave"]));
    expect(imp.asset.model.sockets.rightHand).toBe("hand.R");
    await ok("asset_import", { source: { library: "models", path: "mug.glb" }, assetId: "mug" });
    const list = await ok("asset_list", { kind: "model" });
    expect(list.assets.length).toBe(2);
    const bad = await err("asset_import", { source: { base64: Buffer.from("nope").toString("base64"), filename: "x.glb" } });
    expect(bad.code).toBe("INVALID_ASSET");
    if (HAS_BLENDER) {
      const insp = await ok("asset_inspect", { assetId: "mika" });
      expect(fs.statSync(insp.viewPath).size).toBeLessThan(150_000);
      expect(insp.blender.clipsFound).toEqual(["idle", "point", "run", "walk", "wave"]);
    }
  }, 60_000);

  it("builds a 3D scene and reports structured errors without changing it", async () => {
    const sc = await ok("scene_create", { sceneId: "room", kind: "3d", canvas: { width: 192, height: 108, fps: 12 }, duration: 24 });
    expect(sc.kind).toBe("3d");
    await ok("object_add", {
      sceneId: "room",
      objects: [
        { id: "floor", primitive: { shape: "plane", color: "#99aa88" } },
        { id: "mika", asset: "mika", clip: "walk" },
        { id: "cup", asset: "mug", attach: { object: "mika", bone: "rightHand" } },
      ],
      lights: [{ id: "sun", type: "sun", intensity: 3, rotation: { x: -50, y: 30, z: 0 } }],
    });
    await ok("scene_settings_3d", { sceneId: "room", camera: { position: { x: 0, y: 1.3, z: 4 }, lookAt: { object: "mika", bone: "spine" } }, render: { quality: "draft" } });
    await ok("timeline_apply", {
      sceneId: "room",
      operations: [
        { type: "keyframe.add", target: "mika", property: "clip", frame: 12, value: "wave" },
        { type: "keyframe.add", target: "mika", property: "morph.smile", frame: 0, value: 0 },
        { type: "keyframe.add", target: "mika", property: "morph.smile", frame: 20, value: 1 },
        { type: "keyframe.add", target: "camera", property: "fov", frame: 0, value: 40 },
      ],
    });
    const before = (await ok("scene_get", { sceneId: "room" })).scene;
    expect(before.kind).toBe("3d");
    const cases: [string, Record<string, unknown>, string][] = [
      ["object_update", { sceneId: "room", id: "mika", patch: { clip: "fly" } }, "CLIP_NOT_FOUND"],
      ["object_add", { sceneId: "room", objects: [{ id: "c2", asset: "mug", attach: { object: "mika", bone: "tail" } }] }, "BONE_NOT_FOUND"],
      ["object_update", { sceneId: "room", id: "mika", patch: { morphs: { frown: 1 } } }, "MORPH_NOT_FOUND"],
      ["object_add", { sceneId: "room", objects: [{ id: "x", asset: "ghost" }] }, "ASSET_NOT_FOUND"],
      ["object_add", { sceneId: "room", objects: [{ id: "x", position: { x: "far", y: 0, z: 0 } }] }, "INVALID_ARGUMENT"],
      ["object_update", { sceneId: "room", id: "nobody", patch: { visible: false } }, "LAYER_NOT_FOUND"],
      ["timeline_apply", { sceneId: "room", operations: [{ type: "keyframe.add", target: "mika", property: "clip", frame: 5, value: "dance" }] }, "CLIP_NOT_FOUND"],
      ["timeline_apply", { sceneId: "room", operations: [{ type: "keyframe.add", target: "mika", property: "opacity", frame: 5, value: 1 }] }, "UNSUPPORTED_PROPERTY"],
      ["object_update", { sceneId: "room", id: "mika", patch: { parent: "cup" } }, "PARENT_CYCLE"],
      ["layer_add", { sceneId: "room", layers: [{ id: "l", fill: "#ffffff" }] }, "INVALID_ARGUMENT"],
      ["scene_settings_3d", { sceneId: "room", overlay: { scene: "missing" } }, "VALIDATION_FAILED"],
    ];
    for (const [tool, args, code] of cases) {
      const e = await err(tool, args);
      expect(e.code, `${tool} ${JSON.stringify(args)}: ${e.message}`).toBe(code);
    }
    expect((await ok("scene_get", { sceneId: "room" })).scene).toEqual(before);
    const listed = await ok("object_list", { sceneId: "room" });
    expect(listed.objects.find((o: any) => o.id === "mika").animated).toEqual(expect.arrayContaining(["clip", "morph.smile"]));
    expect(listed.objects.find((o: any) => o.id === "mika").model.sockets).toContain("rightHand");
  }, 60_000);

  it.skipIf(!HAS_BLENDER)("measures, previews and renders the 3D scene", async () => {
    const m = await ok("measure_layout", { sceneId: "room", frame: 18, layers: ["mika", "cup"] });
    const mika = m.objects.find((o: any) => o.id === "mika");
    const cup = m.objects.find((o: any) => o.id === "cup");
    expect(Object.keys(mika.bones).sort()).toEqual(["head", "hips", "leftHand", "rightHand", "root"]);
    const hand = mika.bones.rightHand.world;
    expect(Math.hypot(cup.world.position.x - hand.x, cup.world.position.y - hand.y, cup.world.position.z - hand.z)).toBeLessThan(0.01);
    expect(mika.clips[0].name).toBe("wave");
    expect(mika.screen.onScreen).toBe(true);
    const pv = await ok("render_preview", { sceneId: "room", frame: 18, debug: true });
    expect(fs.existsSync(pv.viewPath)).toBe(true);
    expect(pv.layout3d.objects.length).toBe(3);
    const fr = await ok("render_frame", { sceneId: "room", frame: 3 });
    expect(fr.artifact.pixelSha256).toMatch(/^[0-9a-f]{64}$/);
    const start = await ok("render_video_start", { sceneId: "room", endFrame: 6 });
    let st = await ok("render_video_status", { renderId: start.renderId, waitSeconds: 45 });
    for (let i = 0; i < 3 && st.status !== "completed"; i++) st = await ok("render_video_status", { renderId: start.renderId, waitSeconds: 45 });
    expect(st.status, JSON.stringify(st.error)).toBe("completed");
    expect(fs.statSync(st.artifact.path).size).toBeGreaterThan(1000);
    const bad = await err("measure_layout", { sceneId: "room", frame: 400 });
    expect(bad.code).toBe("INVALID_FRAME");
  }, 240_000);
});
