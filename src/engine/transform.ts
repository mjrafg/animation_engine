/**
 * Transform resolution: evaluated layer states -> local/world/screen matrices.
 *
 * Definitions (all matrices map "from" space -> "to" space, canvas convention, y down):
 *
 *   pivot frame of a layer (its "local space"): origin at the layer's pivot, axes rotated and
 *   scaled by the layer. Children's x/y are expressed in their parent's pivot frame.
 *
 *   localMatrix  = [T(parentPointOffset)] · T(x, y) · R(rotation) · S(scaleX, scaleY)
 *                  maps this layer's pivot frame -> parent's pivot frame (or world if no parent)
 *   worldMatrix  = parent.worldMatrix · localMatrix           (pivot frame -> world)
 *   boxMatrix    = worldMatrix · T(-anchorX·width, -anchorY·height)
 *                  maps layer-box pixels (0..width, 0..height) -> world
 *   cameraMatrix = T(W/2, H/2) · S(cam.scale) · R(-cam.rotation) · T(-W/2 - cam.x, -H/2 - cam.y)
 *                  maps world -> screen (output canvas pixels)
 *   screenBoxMatrix = cameraMatrix · boxMatrix
 *
 * The transform hierarchy never affects draw order; see `renderOrder`.
 */
import { compose, multiply, rotateDeg, scale, translate, type Mat2D } from "../math/matrix.js";
import type { CameraState, FrameState, LayerState } from "../timeline/evaluate.js";

export interface ResolvedLayer {
  state: LayerState;
  localMatrix: Mat2D;
  worldMatrix: Mat2D;
  boxMatrix: Mat2D;
  screenBoxMatrix: Mat2D;
  /** Product of own and ancestor opacity. */
  effectiveOpacity: number;
  /** False if this layer or any ancestor is invisible. */
  effectiveVisible: boolean;
  /** Number of ancestors. */
  depth: number;
}

export interface ResolvedFrame {
  frame: number;
  canvas: { width: number; height: number };
  camera: CameraState;
  cameraMatrix: Mat2D;
  layers: ResolvedLayer[]; // document order
  byId: Map<string, ResolvedLayer>;
}

export function cameraMatrix(cam: CameraState, width: number, height: number): Mat2D {
  const cx = width / 2;
  const cy = height / 2;
  return compose(translate(cx, cy), scale(cam.scale), rotateDeg(-cam.rotation), translate(-cx - cam.x, -cy - cam.y));
}

/** Position of a normalised box point relative to the layer's pivot, in its pivot frame. */
export function normPointInPivotFrame(l: LayerState, p: { x: number; y: number }) {
  return { x: (p.x - l.anchorX) * l.width, y: (p.y - l.anchorY) * l.height };
}

export function localMatrixOf(l: LayerState, parent: LayerState | undefined): Mat2D {
  const own = compose(translate(l.x, l.y), rotateDeg(l.rotation), scale(l.scaleX, l.scaleY));
  if (parent && l.parentPoint) {
    const pt = parent.attachmentPoints[l.parentPoint];
    if (pt) {
      const off = normPointInPivotFrame(parent, pt);
      return multiply(translate(off.x, off.y), own);
    }
  }
  return own;
}

export function resolveFrame(state: FrameState, canvas: { width: number; height: number }): ResolvedFrame {
  const cam = cameraMatrix(state.camera, canvas.width, canvas.height);
  const byId = new Map<string, ResolvedLayer>();
  const inProgress = new Set<string>();

  const resolve = (l: LayerState): ResolvedLayer => {
    const done = byId.get(l.id);
    if (done) return done;
    if (inProgress.has(l.id)) throw new Error(`Parent cycle at layer "${l.id}"`); // prevented by validation
    inProgress.add(l.id);
    const parentState = l.parent ? state.byId.get(l.parent) : undefined;
    const parent = parentState ? resolve(parentState) : undefined;
    const localMatrix = localMatrixOf(l, parentState);
    const worldMatrix = parent ? multiply(parent.worldMatrix, localMatrix) : localMatrix;
    const boxMatrix = multiply(worldMatrix, translate(-l.anchorX * l.width, -l.anchorY * l.height));
    const r: ResolvedLayer = {
      state: l,
      localMatrix,
      worldMatrix,
      boxMatrix,
      screenBoxMatrix: multiply(cam, boxMatrix),
      effectiveOpacity: l.opacity * (parent ? parent.effectiveOpacity : 1),
      effectiveVisible: l.visible && (parent ? parent.effectiveVisible : true),
      depth: parent ? parent.depth + 1 : 0,
    };
    inProgress.delete(l.id);
    byId.set(l.id, r);
    return r;
  };

  const layers = state.layers.map(resolve);
  return { frame: state.frame, canvas, camera: state.camera, cameraMatrix: cam, layers, byId };
}

/**
 * Global render order: ascending `z`, ties broken by document order. Independent of the
 * parent/child hierarchy, so a child may draw below its parent or above unrelated layers.
 */
export function renderOrder(layers: ResolvedLayer[]): ResolvedLayer[] {
  return [...layers].sort((a, b) => a.state.z - b.state.z || a.state.index - b.state.index);
}
