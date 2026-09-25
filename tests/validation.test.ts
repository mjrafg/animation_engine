import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateScene } from "../src/scene/validate.js";
import { baseScene, tmpDir, writeTestPng } from "./helpers.js";

const codes = (input: unknown, opts = {}) => {
  const r = validateScene(input, opts);
  return r.errors.map((e) => e.code);
};

describe("scene validation", () => {
  it("accepts a minimal scene and fills defaults", () => {
    const r = validateScene(baseScene({ layers: [{ id: "a", fill: "#fff", width: 10, height: 10 }] }));
    expect(r.ok).toBe(true);
    const l = r.scene!.layers[0];
    expect(l).toMatchObject({ x: 0, y: 0, scaleX: 1, scaleY: 1, anchorX: 0.5, anchorY: 0.5, rotation: 0, opacity: 1, visible: true, z: 0 });
    expect(r.scene!.camera).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
  });

  it("rejects duplicate layer ids", () => {
    expect(codes(baseScene({ layers: [{ id: "a" }, { id: "a" }] }))).toContain("DUPLICATE_LAYER_ID");
  });

  it("rejects references to missing assets (layer and keyframe)", () => {
    const s = baseScene({
      layers: [{ id: "a", asset: "nope" }],
      animations: [{ target: "a", property: "asset", keyframes: [{ frame: 0, value: "alsoNope" }] }],
    });
    const r = validateScene(s);
    expect(r.errors.filter((e) => e.code === "MISSING_ASSET")).toHaveLength(2);
    expect(r.errors[0].path).toEqual(["layers", 0, "asset"]);
  });

  it("rejects missing asset files when a baseDir is given", async () => {
    const dir = tmpDir();
    await writeTestPng(path.join(dir, "ok.png"), 4, 4, () => {});
    const s = baseScene({ assets: { ok: { src: "ok.png" }, gone: { src: "gone.png" } } });
    const r = validateScene(s, { baseDir: dir });
    expect(r.errors.map((e) => [e.code, e.path.join(".")])).toEqual([["MISSING_ASSET_FILE", "assets.gone.src"]]);
  });

  it("rejects NaN, Infinity and wrong types (programmatic input)", () => {
    expect(codes(baseScene({ layers: [{ id: "a", x: NaN }] }))).toContain("INVALID_TYPE");
    expect(codes(baseScene({ layers: [{ id: "a", y: Infinity }] }))).toContain("INVALID_TYPE");
    expect(codes(baseScene({ layers: [{ id: "a", rotation: "90" }] }))).toContain("INVALID_TYPE");
  });

  it("rejects negative dimensions and invalid anchors/opacity", () => {
    expect(codes(baseScene({ layers: [{ id: "a", width: -1 }] }))).toContain("VALUE_TOO_SMALL");
    expect(codes(baseScene({ layers: [{ id: "a", anchorX: 1.5 }] }))).toContain("VALUE_TOO_BIG");
    expect(codes(baseScene({ layers: [{ id: "a", anchorY: -0.1 }] }))).toContain("VALUE_TOO_SMALL");
    expect(codes(baseScene({ layers: [{ id: "a", opacity: 2 }] }))).toContain("VALUE_TOO_BIG");
  });

  it("rejects unknown properties (typos)", () => {
    const r = validateScene(baseScene({ layers: [{ id: "a", rotaton: 5 }] }));
    expect(r.errors[0].code).toBe("UNKNOWN_PROPERTY");
    expect(r.errors[0].details?.keys).toEqual(["rotaton"]);
  });

  it("rejects missing parents and parent cycles", () => {
    expect(codes(baseScene({ layers: [{ id: "a", parent: "ghost" }] }))).toEqual(["MISSING_PARENT"]);
    expect(codes(baseScene({ layers: [{ id: "a", parent: "a" }] }))).toContain("PARENT_CYCLE");
    const cyc = validateScene(
      baseScene({ layers: [{ id: "a", parent: "c" }, { id: "b", parent: "a" }, { id: "c", parent: "b" }] }),
    );
    expect(cyc.errors.map((e) => e.code)).toEqual(["PARENT_CYCLE"]);
    expect(cyc.errors[0].details?.cycle).toHaveLength(3);
  });

  it("validates parentPoint against the parent's attachment points", () => {
    const s = baseScene({
      assets: { hand: { src: "x.png", attachmentPoints: { grip: { x: 0.5, y: 0.5 } } } },
      layers: [
        { id: "hand", asset: "hand" },
        { id: "cup", parent: "hand", parentPoint: "grip" },
        { id: "bad", parent: "hand", parentPoint: "thumb" },
        { id: "orphan", parentPoint: "grip" },
      ],
    });
    const c = codes(s);
    expect(c).toContain("MISSING_ATTACHMENT_POINT");
    expect(c).toContain("PARENT_POINT_WITHOUT_PARENT");
    expect(c).toHaveLength(2);
  });

  it("rejects invalid keyframes", () => {
    const anim = (kfs: unknown[], property = "x", target = "a") => baseScene({ layers: [{ id: "a" }], animations: [{ target, property, keyframes: kfs }] });
    expect(codes(anim([{ frame: -1, value: 0 }]))).toContain("VALUE_TOO_SMALL");
    expect(codes(anim([{ frame: 1.5, value: 0 }]))).toContain("INVALID_TYPE");
    expect(codes(anim([{ frame: 1, value: 0 }, { frame: 1, value: 2 }]))).toEqual(["DUPLICATE_KEYFRAME"]);
    expect(codes(anim([]))).toContain("VALUE_TOO_SMALL");
    expect(codes(anim([{ frame: 0, value: "ten" }]))).toEqual(["INVALID_KEYFRAME_VALUE"]);
    expect(codes(anim([{ frame: 0, value: 2 }], "opacity"))).toEqual(["VALUE_TOO_BIG"]);
  });

  it("rejects unsupported properties and targets", () => {
    const s = (target: string, property: string) => baseScene({ layers: [{ id: "a" }], animations: [{ target, property, keyframes: [{ frame: 0, value: 1 }] }] });
    expect(codes(s("a", "skew"))).toEqual(["UNSUPPORTED_PROPERTY"]);
    expect(codes(s("camera", "opacity"))).toEqual(["UNSUPPORTED_PROPERTY"]);
    expect(codes(s("ghost", "x"))).toEqual(["MISSING_TARGET"]);
  });

  it("rejects invalid interpolation types and non-step discrete tracks", () => {
    const s = (kf: Record<string, unknown>, property = "x") =>
      baseScene({ layers: [{ id: "a" }], animations: [{ target: "a", property, keyframes: [kf] }] });
    expect(codes(s({ frame: 0, value: 1, interpolation: "bounce" }))).toContain("INVALID_VALUE");
    expect(codes(s({ frame: 0, value: false, interpolation: "linear" }, "visible"))).toEqual(["INVALID_INTERPOLATION"]);
    expect(codes(s({ frame: 0, value: 1, interpolation: "cubic-bezier" }))).toEqual(["MISSING_BEZIER"]);
    expect(codes(s({ frame: 0, value: 1, interpolation: "cubic-bezier", bezier: [2, 0, 1, 1] }))).toContain("VALUE_TOO_BIG");
  });

  it("rejects duplicate tracks for the same property", () => {
    const s = baseScene({
      layers: [{ id: "a" }],
      animations: [
        { target: "a", property: "x", keyframes: [{ frame: 0, value: 1 }] },
        { target: "a", property: "x", keyframes: [{ frame: 0, value: 2 }] },
      ],
    });
    expect(codes(s)).toEqual(["DUPLICATE_TRACK"]);
  });

  it("rejects invalid camera values", () => {
    expect(codes(baseScene({ camera: { scale: 0 } }))).toContain("VALUE_TOO_SMALL");
    expect(codes(baseScene({ camera: { scale: -2 } }))).toContain("VALUE_TOO_SMALL");
    expect(codes(baseScene({ camera: { zoom: 2 } }))).toContain("UNKNOWN_PROPERTY");
    const s = baseScene({ animations: [{ target: "camera", property: "scale", keyframes: [{ frame: 0, value: 0 }] }] });
    expect(codes(s)).toEqual(["VALUE_TOO_SMALL"]);
  });

  it("rejects invalid masks", () => {
    expect(codes(baseScene({ layers: [{ id: "a", mask: { type: "layer", layer: "ghost" } }] }))).toEqual(["INVALID_MASK"]);
    expect(codes(baseScene({ layers: [{ id: "a", mask: { type: "layer", layer: "a" } }] }))).toEqual(["INVALID_MASK"]);
    expect(codes(baseScene({ layers: [{ id: "a", mask: { type: "circle", r: 3 } }] }))[0]).toMatch(/INVALID/);
    expect(codes(baseScene({ layers: [{ id: "a", mask: { type: "rect", x: 0, y: 0, width: -5, height: 5 } }] }))).toContain("VALUE_TOO_SMALL");
  });

  it("reserves the camera id and rejects bad canvas values", () => {
    expect(codes(baseScene({ layers: [{ id: "camera" }] }))).toEqual(["RESERVED_LAYER_ID"]);
    expect(codes({ canvas: { width: 0, height: 10, fps: 30 }, duration: 1 })).toContain("VALUE_TOO_SMALL");
    expect(codes({ canvas: { width: 10, height: 10, fps: 30 }, duration: 0 })).toContain("VALUE_TOO_SMALL");
  });

  it("never throws on garbage input", () => {
    for (const g of [null, 42, "scene", [], { layers: "x" }, { canvas: {} }]) {
      expect(() => validateScene(g)).not.toThrow();
      expect(validateScene(g).ok).toBe(false);
    }
  });
});
