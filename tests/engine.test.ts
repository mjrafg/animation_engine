import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { AnimationEngine } from "../src/api/engine.js";
import { apply, compose, rotateDeg, translate } from "../src/math/matrix.js";
import { cameraMatrix, renderOrder } from "../src/engine/transform.js";
import { cubicBezier } from "../src/timeline/easing.js";
import { baseScene, pixel, tmpDir } from "./helpers.js";

async function engine(doc: Record<string, unknown>) {
  const e = new AnimationEngine(doc, tmpDir());
  await e.prepare();
  return e;
}

const close = (a: { x: number; y: number }, b: { x: number; y: number }, d = 1e-6) => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  void d;
};

describe("matrix", () => {
  it("rotates clockwise on a y-down canvas", () => {
    close(apply(rotateDeg(90), { x: 1, y: 0 }), { x: 0, y: 1 });
  });
  it("compose applies right-most first", () => {
    close(apply(compose(translate(10, 0), rotateDeg(90)), { x: 1, y: 0 }), { x: 10, y: 1 });
  });
});

describe("pivot / anchor", () => {
  it("x/y place the pivot; box offsets follow the anchor", async () => {
    const e = await engine(baseScene({ layers: [{ id: "a", fill: "#fff", x: 100, y: 50, width: 40, height: 20, anchorX: 0.25, anchorY: 1 }] }));
    const l = e.measureLayout(0).layers[0];
    expect(l.worldPivot).toEqual({ x: 100, y: 50 });
    expect(l.worldBounds).toEqual({ left: 90, top: 30, right: 130, bottom: 50 });
  });

  it("rotation happens around the pivot (pivot stays fixed)", async () => {
    const e = await engine(baseScene({ layers: [{ id: "a", fill: "#fff", x: 100, y: 50, width: 40, height: 20, anchorX: 0, anchorY: 0.5, rotation: 90 }] }));
    const l = e.measureLayout(0).layers[0];
    expect(l.worldPivot).toEqual({ x: 100, y: 50 });
    // box extends from the pivot along +x before rotation -> along +y after 90° clockwise
    expect(l.worldBounds).toEqual({ left: 90, top: 50, right: 110, bottom: 90 });
    expect(l.worldCenter).toEqual({ x: 100, y: 70 });
  });

  it("rendered size = width × scaleX, height × scaleY; negative scale mirrors", async () => {
    const e = await engine(baseScene({ layers: [{ id: "a", fill: "#fff", x: 100, y: 50, width: 40, height: 20, scaleX: 2, scaleY: 0.5, anchorX: 0, anchorY: 0 }] }));
    expect(e.measureLayout(0).layers[0].worldBounds).toEqual({ left: 100, top: 50, right: 180, bottom: 60 });
    const m = await engine(baseScene({ layers: [{ id: "a", fill: "#fff", x: 100, y: 50, width: 40, height: 20, scaleX: -1, anchorX: 0, anchorY: 0 }] }));
    expect(m.measureLayout(0).layers[0].worldBounds).toEqual({ left: 60, top: 50, right: 100, bottom: 70 });
  });
});

describe("transform hierarchy", () => {
  const rig = (extra: Record<string, unknown> = {}) =>
    baseScene({
      layers: [
        { id: "body", x: 100, y: 100 },
        { id: "upper", parent: "body", x: 10, y: 0, width: 10, height: 50, anchorX: 0.5, anchorY: 0, fill: "#f00", z: 5 },
        { id: "fore", parent: "upper", x: 0, y: 50, width: 10, height: 40, anchorX: 0.5, anchorY: 0, fill: "#0f0", z: 1 },
        { id: "hand", parent: "fore", x: 0, y: 40, width: 10, height: 10, anchorX: 0.5, anchorY: 0, fill: "#00f", z: 9, attachmentPoints: { tip: { x: 0.5, y: 1 } } },
      ],
      ...extra,
    });

  it("children inherit parent translation", async () => {
    const e = await engine(rig({ animations: [{ target: "body", property: "x", keyframes: [{ frame: 0, value: 100 }, { frame: 10, value: 200 }] }] }));
    const hand0 = e.measureLayout(0).layers.find((l) => l.id === "hand")!;
    const hand10 = e.measureLayout(10).layers.find((l) => l.id === "hand")!;
    expect(hand0.worldPivot).toEqual({ x: 110, y: 190 });
    expect(hand10.worldPivot).toEqual({ x: 210, y: 190 });
    expect(hand10.attachmentPoints.tip.world).toEqual({ x: 210, y: 200 });
  });

  it("nested rotations accumulate (forearm inherits upper-arm rotation, hand inherits both)", async () => {
    const e = await engine(
      rig({
        animations: [
          { target: "upper", property: "rotation", keyframes: [{ frame: 0, value: -90 }] },
          { target: "fore", property: "rotation", keyframes: [{ frame: 0, value: -90 }] },
        ],
      }),
    );
    const L = Object.fromEntries(e.measureLayout(0).layers.map((l) => [l.id, l]));
    // shoulder at (110,100). upper rotated -90 (counter-clockwise): its +y axis points to +x.
    expect(L.fore.worldPivot).toEqual({ x: 160, y: 100 }); // elbow 50px to the right
    expect(Math.abs(L.fore.worldRotation)).toBeCloseTo(180); // -180 ≡ 180
    expect(L.hand.worldPivot).toEqual({ x: 160, y: 60 }); // forearm points up after 180° total
    expect(L.hand.attachmentPoints.tip.world).toEqual({ x: 160, y: 50 });
  });

  it("parent scale scales child offsets and sizes", async () => {
    const e = await engine(rig({ layers: [{ id: "body", x: 0, y: 0, scaleX: 2, scaleY: 2 }, { id: "c", parent: "body", x: 10, y: 5, width: 4, height: 4, anchorX: 0, anchorY: 0, fill: "#fff" }] }));
    const c = e.measureLayout(0).layers.find((l) => l.id === "c")!;
    expect(c.worldBounds).toEqual({ left: 20, top: 10, right: 28, bottom: 18 });
  });

  it("parentPoint attaches the child's origin to a parent attachment point", async () => {
    const e = await engine(
      baseScene({
        layers: [
          { id: "p", fill: "#fff", x: 50, y: 50, width: 20, height: 40, anchorX: 0.5, anchorY: 0.5, rotation: 90, attachmentPoints: { end: { x: 0.5, y: 1 } } },
          { id: "c", parent: "p", parentPoint: "end", fill: "#f00", width: 2, height: 2 },
        ],
      }),
    );
    const L = Object.fromEntries(e.measureLayout(0).layers.map((l) => [l.id, l]));
    expect(L.p.attachmentPoints.end.world).toEqual({ x: 30, y: 50 });
    expect(L.c.worldPivot).toEqual({ x: 30, y: 50 });
  });
});

describe("global z order is independent from hierarchy", () => {
  const scene = baseScene({
    canvas: { width: 100, height: 100, fps: 10, background: "#000000" },
    layers: [
      { id: "character", x: 50, y: 50 },
      { id: "body", parent: "character", fill: "#ff0000", width: 60, height: 60, z: 10 },
      { id: "counter", fill: "#00ff00", x: 50, y: 80, width: 100, height: 40, z: 20 },
      { id: "arm", parent: "character", fill: "#0000ff", x: 0, y: 30, width: 20, height: 20, z: 30 },
      { id: "under", parent: "body", fill: "#ffffff", x: 0, y: 0, width: 10, height: 10, z: 5 },
    ],
  });

  it("orders by z, ties by document order", async () => {
    const e = await engine(scene);
    expect(e.measureLayout(0).drawOrder).toEqual(["under", "body", "counter", "arm"]);
    const r = e.resolve(0);
    expect(renderOrder(r.layers).map((l) => l.state.id)).toEqual(["character", "under", "body", "counter", "arm"]);
  });

  it("a child draws above an unrelated layer that covers its parent, and below its own parent", async () => {
    const e = await engine(scene);
    const f = (await e.renderFrame(0)).rgba();
    const img = { width: 100, data: f };
    expect(pixel(img, 50, 80).slice(0, 3)).toEqual([0, 0, 255]); // arm (z30) over counter (z20)
    expect(pixel(img, 30, 70).slice(0, 3)).toEqual([0, 255, 0]); // counter (z20) over body (z10)
    expect(pixel(img, 30, 40).slice(0, 3)).toEqual([255, 0, 0]); // body
    expect(pixel(img, 50, 50).slice(0, 3)).toEqual([255, 0, 0]); // child "under" (z5) hidden below its parent
  });

  it("z can be switched with a step keyframe", async () => {
    const e = await engine({
      ...scene,
      animations: [{ target: "arm", property: "z", keyframes: [{ frame: 0, value: 15 }, { frame: 5, value: 30 }] }],
    });
    expect(e.measureLayout(4).drawOrder).toEqual(["under", "body", "arm", "counter"]);
    expect(e.measureLayout(5).drawOrder).toEqual(["under", "body", "counter", "arm"]);
  });
});

describe("timeline", () => {
  const track = (property: string, keyframes: unknown[], layer: Record<string, unknown> = {}) =>
    baseScene({ layers: [{ id: "a", fill: "#fff", width: 10, height: 10, ...layer }], animations: [{ target: "a", property, keyframes }] });

  it("linear interpolation, holds before first / after last key", async () => {
    const e = await engine(track("x", [{ frame: 5, value: 100 }, { frame: 15, value: 200 }]));
    const x = (f: number) => e.evaluate(f).byId.get("a")!.x;
    expect([x(0), x(5), x(10), x(12.5), x(15), x(19)]).toEqual([100, 100, 150, 175, 200, 200]);
  });

  it("step holds the left value and switches exactly on the key frame", async () => {
    const e = await engine(track("x", [{ frame: 0, value: 1, interpolation: "step" }, { frame: 10, value: 2 }]));
    const x = (f: number) => e.evaluate(f).byId.get("a")!.x;
    expect([x(0), x(9), x(9.99), x(10)]).toEqual([1, 1, 1, 2]);
  });

  it("discrete properties (asset/visible) default to step", async () => {
    const e = await engine(track("visible", [{ frame: 0, value: true }, { frame: 7, value: false }]));
    expect(e.evaluate(6).byId.get("a")!.visible).toBe(true);
    expect(e.evaluate(7).byId.get("a")!.visible).toBe(false);
    expect(e.measureLayout(7).drawOrder).toEqual([]);
  });

  it("easings hit endpoints and bend the curve", async () => {
    const vals = async (interp: string) => {
      const e = await engine(track("x", [{ frame: 0, value: 0, interpolation: interp }, { frame: 10, value: 100 }]));
      return [0, 2, 5, 8, 10].map((f) => e.evaluate(f).byId.get("a")!.x);
    };
    const inn = await vals("ease-in");
    const out = await vals("ease-out");
    const io = await vals("ease-in-out");
    expect(inn[0]).toBe(0);
    expect(inn[4]).toBe(100);
    expect(inn[2]).toBeLessThan(50);
    expect(out[2]).toBeGreaterThan(50);
    expect(io[2]).toBeCloseTo(50, 5);
    expect(io[1]).toBeLessThan(20);
  });

  it("cubic-bezier matches CSS (ease = 0.25,0.1,0.25,1 at t=0.5 ≈ 0.8024)", () => {
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(cubicBezier(0, 0, 1, 1)(0.3)).toBeCloseTo(0.3, 6);
  });

  it("clamps overshooting easing on bounded properties", async () => {
    const e = await engine(
      track("opacity", [{ frame: 0, value: 0, interpolation: "cubic-bezier", bezier: [0.3, 1.8, 0.7, 1.8] }, { frame: 10, value: 1 }]),
    );
    const vals = Array.from({ length: 11 }, (_, f) => e.evaluate(f).byId.get("a")!.opacity);
    expect(Math.max(...vals)).toBe(1);
    expect(Math.min(...vals)).toBe(0);
  });

  it("the mouth-style asset swap uses the same generic timeline", async () => {
    const e = await engine(
      baseScene({
        assets: {},
        layers: [{ id: "m", fill: "#000", width: 1, height: 1 }],
        animations: [{ target: "m", property: "fill", keyframes: [{ frame: 0, value: "#111111" }, { frame: 7, value: "#222222" }, { frame: 11, value: "#333333" }] }],
      }),
    );
    expect([0, 6, 7, 10, 11].map((f) => e.evaluate(f).byId.get("m")!.fill)).toEqual(["#111111", "#111111", "#222222", "#222222", "#333333"]);
  });
});

describe("camera", () => {
  it("identity camera leaves screen = world", () => {
    const m = cameraMatrix({ x: 0, y: 0, scale: 1, rotation: 0 }, 1920, 1080);
    close(apply(m, { x: 123, y: 456 }), { x: 123, y: 456 });
  });

  it("pan: camera x/y shifts the view; zoom scales about the view centre", () => {
    const pan = cameraMatrix({ x: 100, y: -50, scale: 1, rotation: 0 }, 1920, 1080);
    close(apply(pan, { x: 1060, y: 490 }), { x: 960, y: 540 });
    const zoom = cameraMatrix({ x: 0, y: 0, scale: 2, rotation: 0 }, 1920, 1080);
    close(apply(zoom, { x: 960, y: 540 }), { x: 960, y: 540 });
    close(apply(zoom, { x: 1060, y: 540 }), { x: 1160, y: 540 });
    const both = cameraMatrix({ x: 100, y: 0, scale: 2, rotation: 0 }, 1920, 1080);
    close(apply(both, { x: 1060, y: 540 }), { x: 960, y: 540 }); // the camera looks at world (1060,540)
  });

  it("camera keyframes change screen geometry but not world geometry or layer definitions", async () => {
    const doc = baseScene({
      layers: [{ id: "a", fill: "#fff", x: 150, y: 50, width: 20, height: 20 }],
      animations: [
        { target: "camera", property: "scale", keyframes: [{ frame: 0, value: 1 }, { frame: 10, value: 2 }] },
        { target: "camera", property: "x", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 50 }] },
      ],
    });
    const before = JSON.stringify(doc);
    const e = await engine(doc);
    const a0 = e.measureLayout(0).layers[0];
    const a10 = e.measureLayout(10).layers[0];
    expect(a0.worldBounds).toEqual(a10.worldBounds);
    expect(a0.screenBounds).toEqual({ left: 140, top: 40, right: 160, bottom: 60 });
    // canvas 200x100: view centre (100,50) looks at world (150,50), zoom 2
    expect(a10.screenCenter).toEqual({ x: 100, y: 50 });
    expect(a10.screenBounds).toEqual({ left: 80, top: 30, right: 120, bottom: 70 });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("camera zoom is visible in rendered pixels", async () => {
    const e = await engine(
      baseScene({
        canvas: { width: 100, height: 100, fps: 10 },
        layers: [{ id: "sq", fill: "#ffffff", x: 50, y: 50, width: 20, height: 20 }],
        animations: [{ target: "camera", property: "scale", keyframes: [{ frame: 0, value: 1 }, { frame: 10, value: 2 }] }],
      }),
    );
    const at = async (f: number, x: number, y: number) => pixel({ width: 100, data: (await e.renderFrame(f)).rgba() }, x, y)[0];
    expect(await at(0, 50 + 15, 50)).toBe(0); // outside the 20px square
    expect(await at(10, 50 + 15, 50)).toBe(255); // inside once zoomed 2x
  });
});

describe("rendering", () => {
  it("opacity blends, invisible layers are skipped, masks clip", async () => {
    const e = await engine(
      baseScene({
        canvas: { width: 100, height: 100, fps: 10, background: "#000000" },
        layers: [
          { id: "half", fill: "#ffffff", x: 25, y: 25, width: 50, height: 50, opacity: 0.5 },
          { id: "hidden", fill: "#ff0000", x: 75, y: 25, width: 50, height: 50, visible: false },
          { id: "masked", fill: "#00ff00", x: 50, y: 75, width: 100, height: 50, mask: { type: "rect", x: 0, y: 50, width: 30, height: 50 } },
          { id: "maskShape", fill: "#fff", x: 90, y: 10, width: 20, height: 20, visible: false },
          { id: "layerMasked", fill: "#0000ff", x: 90, y: 10, width: 40, height: 40, mask: { type: "layer", layer: "maskShape" } },
        ],
      }),
    );
    const img = { width: 100, data: (await e.renderFrame(0)).rgba() };
    expect(pixel(img, 25, 25)[0]).toBeGreaterThanOrEqual(127);
    expect(pixel(img, 25, 25)[0]).toBeLessThanOrEqual(128);
    expect(pixel(img, 75, 40).slice(0, 3)).toEqual([0, 0, 0]); // hidden
    expect(pixel(img, 10, 90).slice(0, 3)).toEqual([0, 255, 0]); // inside rect mask
    expect(pixel(img, 60, 90).slice(0, 3)).toEqual([0, 0, 0]); // outside rect mask
    expect(pixel(img, 90, 10).slice(0, 3)).toEqual([0, 0, 255]); // inside layer mask
    expect(pixel(img, 75, 25).slice(0, 3)).toEqual([0, 0, 0]); // outside layer mask
  });

  it("is deterministic: same scene + frame -> identical pixels (same and fresh engine)", async () => {
    const doc = baseScene({
      layers: [
        { id: "a", fill: "#3366cc", x: 60, y: 40, width: 50, height: 30 },
        { id: "b", parent: "a", fill: "#cc6633", x: 20, y: 10, width: 30, height: 30, opacity: 0.7 },
      ],
      animations: [{ target: "a", property: "rotation", keyframes: [{ frame: 0, value: 0, interpolation: "ease-in-out" }, { frame: 19, value: 33 }] }],
    });
    const hash = async (e: AnimationEngine, f: number) => crypto.createHash("sha256").update((await e.renderFrame(f)).rgba()).digest("hex");
    const e1 = await engine(doc);
    const e2 = await engine(structuredClone(doc));
    const h = await hash(e1, 7);
    await hash(e1, 12); // rendering other frames in between must not change results
    expect(await hash(e1, 7)).toBe(h);
    expect(await hash(e2, 7)).toBe(h);
    expect(await hash(e1, 8)).not.toBe(h);
  });

  it("rejects out-of-range frames", async () => {
    const e = await engine(baseScene());
    await expect(e.renderFrame(20)).rejects.toMatchObject({ code: "INVALID_FRAME" });
    expect(() => e.measureLayout(-1)).toThrow(/frame must be an integer/);
    expect(() => e.measureLayout(1.5)).toThrow(expect.objectContaining({ code: "INVALID_FRAME" }));
  });
});
