/**
 * measure_layout: numeric geometry of every layer at a frame, for agents and tests.
 *
 * "world" = scene space before the camera. "screen" = output canvas pixels after the camera.
 * With an identity camera both are equal.
 */
import { apply, boundsOfPoints, clean, cleanMat, cleanRect, cleanVec, type Mat2D, type Rect, type Vec2 } from "../math/matrix.js";
import { isDrawn } from "./displayList.js";
import { normPointInPivotFrame, renderOrder, type ResolvedFrame, type ResolvedLayer } from "./transform.js";

export interface Geometry {
  pivot: Vec2;
  center: Vec2;
  /** Box corners in order: top-left, top-right, bottom-right, bottom-left (of the unrotated box). */
  corners: [Vec2, Vec2, Vec2, Vec2];
  bounds: Rect;
}

export interface LayerLayout {
  id: string;
  parent: string | null;
  asset: string | null;
  sourceTime?: number;
  sourceFrame?: number;
  z: number;
  /** Position in the final draw order (0 = drawn first), or null if not drawn this frame. */
  drawIndex: number | null;
  visible: boolean;
  opacity: number;
  /** Base box size (before any scale). */
  size: { width: number; height: number };
  /** Local property values after timeline evaluation. */
  local: { x: number; y: number; rotation: number; scaleX: number; scaleY: number; anchorX: number; anchorY: number };
  /** Accumulated world rotation (degrees, clockwise) and scale of the pivot frame. */
  worldRotation: number;
  worldScale: { x: number; y: number };

  worldPivot: Vec2;
  worldCenter: Vec2;
  worldBounds: Rect;
  worldCorners: Vec2[];
  screenPivot: Vec2;
  screenCenter: Vec2;
  screenBounds: Rect;
  screenCorners: Vec2[];
  /** True if the screen bounds overlap the output canvas. */
  onScreen: boolean;

  attachmentPoints: Record<string, { world: Vec2; screen: Vec2; normalized: Vec2 }>;
  localMatrix: Mat2D;
  worldMatrix: Mat2D;
}

export interface FrameLayout {
  frame: number;
  canvas: { width: number; height: number };
  camera: { x: number; y: number; scale: number; rotation: number; matrix: Mat2D };
  /** Layer ids in draw order (bottom to top). */
  drawOrder: string[];
  layers: LayerLayout[];
}

function geometry(box: Mat2D, pivotFrame: Mat2D, w: number, h: number): Geometry {
  const corners: [Vec2, Vec2, Vec2, Vec2] = [
    apply(box, { x: 0, y: 0 }),
    apply(box, { x: w, y: 0 }),
    apply(box, { x: w, y: h }),
    apply(box, { x: 0, y: h }),
  ];
  return {
    pivot: cleanVec(apply(pivotFrame, { x: 0, y: 0 })),
    center: cleanVec(apply(box, { x: w / 2, y: h / 2 })),
    corners: corners.map(cleanVec) as Geometry["corners"],
    bounds: cleanRect(boundsOfPoints(corners)),
  };
}

function layerLayout(l: ResolvedLayer, frame: ResolvedFrame, drawIndex: number | null): LayerLayout {
  const s = l.state;
  const world = geometry(l.boxMatrix, l.worldMatrix, s.width, s.height);
  const screenPivotFrame = { ...l.worldMatrix };
  const cam = s.space === "screen" ? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } : frame.cameraMatrix;
  const screenBox = l.screenBoxMatrix;
  const screenPivot = apply(cam, apply(screenPivotFrame, { x: 0, y: 0 }));
  const screen = geometry(screenBox, { a: 1, b: 0, c: 0, d: 1, e: screenPivot.x, f: screenPivot.y }, s.width, s.height);

  const attachmentPoints: LayerLayout["attachmentPoints"] = {};
  for (const [name, p] of Object.entries(s.attachmentPoints)) {
    const local = normPointInPivotFrame(s, p);
    const w = apply(l.worldMatrix, local);
    attachmentPoints[name] = { world: cleanVec(w), screen: cleanVec(apply(cam, w)), normalized: { x: p.x, y: p.y } };
  }

  const m = l.worldMatrix;
  const sb = screen.bounds;
  return {
    id: s.id,
    parent: s.parent,
    asset: s.asset,
    ...(s.sourceFrame !== undefined ? { sourceTime: s.sourceTime, sourceFrame: s.sourceFrame } : {}),
    z: s.z,
    drawIndex,
    visible: l.effectiveVisible,
    opacity: clean(l.effectiveOpacity),
    size: { width: s.width, height: s.height },
    local: { x: s.x, y: s.y, rotation: s.rotation, scaleX: s.scaleX, scaleY: s.scaleY, anchorX: s.anchorX, anchorY: s.anchorY },
    worldRotation: clean((Math.atan2(m.b, m.a) * 180) / Math.PI),
    worldScale: { x: clean(Math.hypot(m.a, m.b)), y: clean((m.a * m.d - m.b * m.c) / (Math.hypot(m.a, m.b) || 1)) },
    worldPivot: world.pivot,
    worldCenter: world.center,
    worldBounds: world.bounds,
    worldCorners: world.corners,
    screenPivot: cleanVec(screenPivot),
    screenCenter: screen.center,
    screenBounds: sb,
    screenCorners: screen.corners,
    onScreen: sb.right > 0 && sb.bottom > 0 && sb.left < frame.canvas.width && sb.top < frame.canvas.height,
    attachmentPoints,
    localMatrix: cleanMat(l.localMatrix),
    worldMatrix: cleanMat(l.worldMatrix),
  };
}

export function measureResolvedLayout(frame: ResolvedFrame): FrameLayout {
  const drawn = renderOrder(frame.layers).filter(isDrawn);
  const drawIndex = new Map(drawn.map((l, i) => [l.state.id, i]));
  return {
    frame: frame.frame,
    canvas: frame.canvas,
    camera: { ...frame.camera, matrix: cleanMat(frame.cameraMatrix) },
    drawOrder: drawn.map((l) => l.state.id),
    layers: frame.layers.map((l) => layerLayout(l, frame, drawIndex.get(l.state.id) ?? null)),
  };
}
