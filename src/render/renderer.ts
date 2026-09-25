/**
 * Renderer abstraction. A backend turns a backend-agnostic DisplayList (plus an optional debug
 * overlay made of primitive shapes) into pixels. The scene model never touches backend APIs.
 *
 *   Renderer
 *   ├── SkiaRenderer        (server side, CPU, @napi-rs/canvas)  <- implemented
 *   └── (future) PixiRenderer (browser, WebGL, live preview/editing)
 */
import type { DisplayList } from "../engine/displayList.js";
import type { LoadedAsset } from "../engine/assets.js";
import type { Vec2 } from "../math/matrix.js";

export type OverlayShape =
  | { kind: "polygon"; points: Vec2[]; stroke: string; lineWidth: number; dash?: number[] }
  | { kind: "circle"; x: number; y: number; radius: number; stroke?: string; fill?: string; lineWidth?: number }
  | { kind: "cross"; x: number; y: number; size: number; color: string; lineWidth: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number; background?: string };

export interface RenderedFrame {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, row-major, width*height*4 bytes. */
  rgba(): Buffer;
  png(): Promise<Buffer>;
}

export interface Renderer {
  readonly name: string;
  /** Decode/upload assets. Called whenever the scene's asset set changes. */
  loadAssets(assets: LoadedAsset[]): Promise<void>;
  render(list: DisplayList, overlay?: OverlayShape[]): Promise<RenderedFrame>;
}
