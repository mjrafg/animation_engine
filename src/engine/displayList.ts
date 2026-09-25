/**
 * Backend-agnostic display list. The engine resolves a frame into an ordered list of simple
 * draw commands (matrix + source + opacity + optional mask). Any Renderer backend (Skia today,
 * PixiJS/WebGL later) only has to execute these commands; it never sees the scene graph.
 */
import { multiply, translate, type Mat2D } from "../math/matrix.js";
import type { Scene } from "../scene/schema.js";
import { renderOrder, type ResolvedFrame, type ResolvedLayer } from "./transform.js";

export type DrawSource = { kind: "image"; assetId: string } | { kind: "fill"; color: string };

export interface DrawMask {
  /** Maps mask-box pixels (0..width, 0..height) to screen pixels. */
  matrix: Mat2D;
  width: number;
  height: number;
  /** "rect": opaque rectangle. Otherwise the alpha of the image/fill defines coverage. */
  source: DrawSource | { kind: "rect" };
  opacity: number;
  invert: boolean;
}

export interface DrawCommand {
  layerId: string;
  z: number;
  /** Maps layer-box pixels (0..width, 0..height) to screen pixels (camera included). */
  matrix: Mat2D;
  width: number;
  height: number;
  opacity: number;
  source: DrawSource;
  mask: DrawMask | null;
}

export interface DisplayList {
  frame: number;
  width: number;
  height: number;
  background: string;
  commands: DrawCommand[];
}

function sourceOf(l: ResolvedLayer): DrawSource | null {
  if (l.state.asset) return { kind: "image", assetId: l.state.asset };
  if (l.state.fill) return { kind: "fill", color: l.state.fill };
  return null;
}

function maskOf(layer: ResolvedLayer, frame: ResolvedFrame): DrawMask | null {
  const m = layer.state.mask;
  if (!m) return null;
  if (m.type === "rect") {
    const base = m.space === "layer" ? layer.screenBoxMatrix : frame.cameraMatrix;
    return {
      matrix: multiply(base, translate(m.x, m.y)),
      width: m.width,
      height: m.height,
      source: { kind: "rect" },
      opacity: 1,
      invert: m.invert,
    };
  }
  const ml = frame.byId.get(m.layer);
  const src = ml ? sourceOf(ml) : null;
  if (!ml || !src) {
    // Missing or empty mask layer: nothing is covered.
    return { matrix: frame.cameraMatrix, width: 0, height: 0, source: { kind: "rect" }, opacity: 1, invert: m.invert };
  }
  return {
    matrix: ml.screenBoxMatrix,
    width: ml.state.width,
    height: ml.state.height,
    source: src,
    opacity: ml.state.opacity,
    invert: m.invert,
  };
}

/** Whether a resolved layer produces pixels at this frame. */
export function isDrawn(l: ResolvedLayer): boolean {
  return (
    l.effectiveVisible &&
    l.effectiveOpacity > 0 &&
    l.state.width > 0 &&
    l.state.height > 0 &&
    sourceOf(l) !== null
  );
}

export function buildDisplayList(scene: Scene, frame: ResolvedFrame): DisplayList {
  const commands: DrawCommand[] = [];
  for (const l of renderOrder(frame.layers)) {
    if (!isDrawn(l)) continue;
    commands.push({
      layerId: l.state.id,
      z: l.state.z,
      matrix: l.screenBoxMatrix,
      width: l.state.width,
      height: l.state.height,
      opacity: l.effectiveOpacity,
      source: sourceOf(l)!,
      mask: maskOf(l, frame),
    });
  }
  return {
    frame: frame.frame,
    width: scene.canvas.width,
    height: scene.canvas.height,
    background: scene.canvas.background,
    commands,
  };
}
