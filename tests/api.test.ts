import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EngineSession, toolDefinitions } from "../src/api/tools.js";
import * as ops from "../src/api/operations.js";
import { ffmpegPath } from "../src/render/video.js";
import { baseScene, tmpDir, writeTestPng } from "./helpers.js";

describe("scene operations (pure, transactional)", () => {
  const start = () => {
    const r = ops.createScene({ canvas: { width: 100, height: 100, fps: 10 }, duration: 10 });
    if (!r.ok) throw new Error("create failed");
    return r.scene;
  };

  it("add / update / remove layers", () => {
    let s = start();
    const a = ops.addLayer(s, { layer: { id: "a", fill: "#fff", width: 10, height: 10 } });
    expect(a.ok).toBe(true);
    s = (a as any).scene;
    expect(ops.addLayer(s, { layer: { id: "a" } })).toMatchObject({ ok: false, errors: [{ code: "DUPLICATE_LAYER_ID" }] });
    const u = ops.updateLayer(s, "a", { x: 42, rotation: 10 });
    expect(u.ok && u.scene.layers[0]).toMatchObject({ x: 42, rotation: 10 });
    expect(ops.updateLayer(s, "a", { opacity: 5 })).toMatchObject({ ok: false, errors: [{ code: "VALUE_TOO_BIG", path: ["layers", 0, "opacity"] }] });
    expect(ops.updateLayer(s, "zzz", { x: 1 })).toMatchObject({ ok: false, errors: [{ code: "MISSING_LAYER" }] });
    const rm = ops.removeLayer(s, { id: "a" });
    expect(rm.ok && rm.scene.layers).toEqual([]);
  });

  it("set_parent rejects cycles without modifying the document", () => {
    let s = start();
    s = (ops.addLayer(s, { layer: { id: "a" } }) as any).scene;
    s = (ops.addLayer(s, { layer: { id: "b", parent: "a" } }) as any).scene;
    const snapshot = JSON.stringify(s);
    const r = ops.setParent(s, { id: "a", parent: "b" });
    expect(r).toMatchObject({ ok: false, errors: [{ code: "PARENT_CYCLE" }] });
    expect(JSON.stringify(s)).toBe(snapshot);
  });

  it("remove_layer with children: error / cascade / reparent", () => {
    let s = start();
    for (const layer of [{ id: "root" }, { id: "mid", parent: "root" }, { id: "leaf", parent: "mid" }]) s = (ops.addLayer(s, { layer }) as any).scene;
    expect(ops.removeLayer(s, { id: "mid" })).toMatchObject({ ok: false, errors: [{ code: "HAS_CHILDREN" }] });
    const c = ops.removeLayer(s, { id: "mid", children: "cascade" });
    expect(c.ok && c.scene.layers.map((l: any) => l.id)).toEqual(["root"]);
    const rp = ops.removeLayer(s, { id: "mid", children: "reparent" });
    expect(rp.ok && rp.scene.layers.find((l: any) => l.id === "leaf").parent).toBe("root");
  });

  it("keyframe add (upsert, sorted) / update / remove", () => {
    let s = start();
    s = (ops.addLayer(s, { layer: { id: "a" } }) as any).scene;
    s = (ops.addKeyframe(s, { target: "a", property: "x", keyframe: { frame: 5, value: 50 } }) as any).scene;
    s = (ops.addKeyframe(s, { target: "a", property: "x", keyframe: { frame: 0, value: 0 } }) as any).scene;
    s = (ops.addKeyframe(s, { target: "a", property: "x", keyframe: { frame: 5, value: 60 } }) as any).scene;
    expect(s.animations[0].keyframes).toEqual([{ frame: 0, value: 0 }, { frame: 5, value: 60 }]);
    s = (ops.updateKeyframe(s, { target: "a", property: "x", frame: 5, patch: { interpolation: "step" } }) as any).scene;
    expect(s.animations[0].keyframes[1].interpolation).toBe("step");
    expect(ops.addKeyframe(s, { target: "a", property: "visible", keyframe: { frame: 0, value: true, interpolation: "linear" } })).toMatchObject({
      ok: false,
      errors: [{ code: "INVALID_INTERPOLATION" }],
    });
    expect(ops.addKeyframe(s, { target: "camera", property: "scale", keyframe: { frame: 0, value: 2 } }).ok).toBe(true);
    s = (ops.removeKeyframe(s, { target: "a", property: "x", frame: 0 }) as any).scene;
    s = (ops.removeKeyframe(s, { target: "a", property: "x", frame: 5 }) as any).scene;
    expect(s.animations).toEqual([]);
  });
});

describe("agent tool session", () => {
  it("exposes JSON-schema tool definitions", () => {
    const defs = toolDefinitions();
    const names = defs.map((d) => d.name);
    for (const n of ["create_scene", "load_scene", "save_scene", "add_layer", "update_layer", "remove_layer", "set_parent", "add_keyframe", "update_keyframe", "remove_keyframe", "process_asset_background", "trim_transparent", "find_components", "remove_component", "render_preview", "render_debug_preview", "measure_layout", "render_frame", "render_video"]) {
      expect(names).toContain(n);
    }
    expect(defs.find((d) => d.name === "measure_layout")!.inputSchema).toMatchObject({ type: "object", required: ["frame"] });
  });

  it("returns machine-readable errors instead of throwing", async () => {
    const s = new EngineSession();
    expect(await s.call("nope", {})).toMatchObject({ ok: false, errors: [{ code: "UNKNOWN_TOOL" }] });
    expect(await s.call("measure_layout", { frame: "x" })).toMatchObject({ ok: false, errors: [{ code: "INVALID_ARGUMENT", path: ["frame"] }] });
    expect(await s.call("render_preview", { frame: 0, out: "x.png" })).toMatchObject({ ok: false, errors: [{ code: "NO_SCENE" }] });
    await s.call("create_scene", { canvas: { width: 64, height: 64, fps: 10 }, duration: 5, baseDir: tmpDir() });
    expect(await s.call("measure_layout", { frame: 99 })).toMatchObject({ ok: false, errors: [{ code: "INVALID_FRAME" }] });
  });

  it("builds, measures, corrects and renders a scene purely through tools", async () => {
    const dir = tmpDir();
    await writeTestPng(path.join(dir, "box.png"), 20, 20, (ctx) => {
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, 20, 20);
    });
    const s = new EngineSession();
    const ok = async (tool: string, args: unknown) => {
      const r = await s.call(tool, args);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      return (r as any).result;
    };
    await ok("create_scene", { canvas: { width: 64, height: 48, fps: 10, background: "#000000" }, duration: 4, baseDir: dir });
    await ok("set_asset", { id: "box", asset: { src: "box.png", attachmentPoints: { corner: { x: 1, y: 1 } } } });
    await ok("add_layer", { layer: { id: "box", asset: "box", x: 10, y: 10 } });
    let layout = await ok("measure_layout", { frame: 0, layers: ["box"] });
    expect(layout.layers[0].worldBounds).toEqual({ left: 0, top: 0, right: 20, bottom: 20 });
    // "inspect" -> the box should be centred: fix with data only
    await ok("update_layer", { id: "box", patch: { x: 32, y: 24 } });
    layout = await ok("measure_layout", { frame: 0, layers: ["box"] });
    expect(layout.layers[0].worldCenter).toEqual({ x: 32, y: 24 });
    expect(layout.layers[0].attachmentPoints.corner.world).toEqual({ x: 42, y: 34 });
    await ok("add_keyframe", { target: "box", property: "rotation", keyframe: { frame: 0, value: 0 } });
    await ok("add_keyframe", { target: "box", property: "rotation", keyframe: { frame: 3, value: 90 } });
    const f = await ok("render_frame", { frame: 3, out: "f3.png" });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(dir, "f3.png"))).toBe(true);
    await ok("render_debug_preview", { frame: 1, out: "debug.png" });
    await ok("save_scene", { path: path.join(dir, "scene.json") });
    const s2 = new EngineSession();
    expect((await s2.call("load_scene", { path: path.join(dir, "scene.json") })).ok).toBe(true);
    expect(((await s2.call("render_frame", { frame: 3 })) as any).result.sha256).toBe(f.sha256);
  });

  it("renders an MP4 through the FFmpeg pipe", async () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, "scene.json"),
      JSON.stringify(
        baseScene({
          canvas: { width: 64, height: 48, fps: 10, background: "#202020" },
          duration: 10,
          layers: [{ id: "a", fill: "#ffcc00", x: 32, y: 24, width: 20, height: 20 }],
          animations: [{ target: "a", property: "x", keyframes: [{ frame: 0, value: 10 }, { frame: 9, value: 54 }] }],
        }),
      ),
    );
    const s = new EngineSession();
    await s.call("load_scene", { path: path.join(dir, "scene.json") });
    const r = await s.call("render_video", { out: "out.mp4" });
    expect(r).toMatchObject({ ok: true, result: { frames: 10, seconds: 1 } });
    const probe = spawnSync(ffmpegPath(), ["-hide_banner", "-i", path.join(dir, "out.mp4")], { encoding: "utf8" });
    expect(probe.stderr).toMatch(/Duration: 00:00:01\.00/);
    expect(probe.stderr).toMatch(/h264.*64x48/);
  }, 60000);
});
