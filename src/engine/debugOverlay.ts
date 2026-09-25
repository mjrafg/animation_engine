/**
 * Builds debug overlay primitives (backend agnostic) from a measured layout. Overlays are drawn
 * on top of a preview only; they never become part of the scene output.
 */
import type { OverlayShape } from "../render/renderer.js";
import type { FrameLayout } from "./layout.js";

export interface DebugOptions {
  /** Rotated layer box outline (solid) */
  bounds?: boolean;
  /** Axis-aligned screen bounds (dashed) */
  aabb?: boolean;
  labels?: boolean;
  pivots?: boolean;
  centers?: boolean;
  attachmentPoints?: boolean;
  /** Also annotate layers that draw nothing (groups / invisible). Default false. */
  includeHidden?: boolean;
  /** Restrict to these layer ids. */
  only?: string[];
  /** Header text with frame number / camera. Default true. */
  header?: boolean;
}

const DEFAULTS: Required<Omit<DebugOptions, "only">> = {
  bounds: true,
  aabb: false,
  labels: true,
  pivots: true,
  centers: true,
  attachmentPoints: true,
  includeHidden: false,
  header: true,
};

/** Stable colour per id (FNV-1a hash -> hue). */
function colorFor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `hsl(${h % 360}, 95%, 55%)`;
}

export function buildDebugOverlay(layout: FrameLayout, opts: DebugOptions = {}): OverlayShape[] {
  const o = { ...DEFAULTS, ...opts };
  const shapes: OverlayShape[] = [];
  const only = opts.only ? new Set(opts.only) : null;
  for (const l of layout.layers) {
    if (only && !only.has(l.id)) continue;
    const drawn = l.drawIndex !== null;
    if (!drawn && !o.includeHidden) continue;
    const color = colorFor(l.id);
    const hasBox = l.size.width > 0 && l.size.height > 0;
    if (o.bounds && hasBox) {
      shapes.push({ kind: "polygon", points: l.screenCorners, stroke: color, lineWidth: 2, dash: drawn ? undefined : [6, 6] });
    }
    if (o.aabb && hasBox) {
      const b = l.screenBounds;
      shapes.push({
        kind: "polygon",
        points: [
          { x: b.left, y: b.top },
          { x: b.right, y: b.top },
          { x: b.right, y: b.bottom },
          { x: b.left, y: b.bottom },
        ],
        stroke: color,
        lineWidth: 1,
        dash: [3, 5],
      });
    }
    if (o.centers && hasBox) {
      shapes.push({ kind: "circle", x: l.screenCenter.x, y: l.screenCenter.y, radius: 3, fill: color });
    }
    if (o.pivots) {
      shapes.push({ kind: "cross", x: l.screenPivot.x, y: l.screenPivot.y, size: 9, color: "#000000", lineWidth: 4 });
      shapes.push({ kind: "cross", x: l.screenPivot.x, y: l.screenPivot.y, size: 8, color, lineWidth: 2 });
      shapes.push({ kind: "circle", x: l.screenPivot.x, y: l.screenPivot.y, radius: 5, stroke: color, lineWidth: 2 });
    }
    if (o.attachmentPoints) {
      for (const [name, p] of Object.entries(l.attachmentPoints)) {
        shapes.push({ kind: "circle", x: p.screen.x, y: p.screen.y, radius: 6, stroke: "#000000", fill: "#ffff00", lineWidth: 2 });
        shapes.push({ kind: "text", x: p.screen.x + 8, y: p.screen.y - 6, text: name, color: "#000000", size: 12, background: "rgba(255,255,0,0.8)" });
      }
    }
    if (o.labels) {
      const anchor = hasBox ? { x: l.screenBounds.left, y: l.screenBounds.top } : l.screenPivot;
      shapes.push({
        kind: "text",
        x: anchor.x + 3,
        y: anchor.y + 3,
        text: `${l.id} z=${l.z}${l.parent ? ` ^${l.parent}` : ""}`,
        color: "#ffffff",
        size: 13,
        background: "rgba(0,0,0,0.65)",
      });
    }
  }
  if (o.header) {
    const c = layout.camera;
    shapes.push({
      kind: "text",
      x: 8,
      y: 8,
      text: `frame ${layout.frame}  camera x=${c.x.toFixed(1)} y=${c.y.toFixed(1)} scale=${c.scale.toFixed(3)} rot=${c.rotation.toFixed(1)}`,
      color: "#ffffff",
      size: 18,
      background: "rgba(0,0,0,0.75)",
    });
  }
  return shapes;
}
