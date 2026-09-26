/**
 * Joint continuity of prepared characters: "does the body stay visually connected when the
 * skeleton moves?"
 *
 * 2D (layered parts, rigid per part): a joint stays visually closed for a rotation range when
 * the JOINT DISK - a disk centred on the child's pivot with the limb's half-width as radius - is
 * covered by the parent or the child art at every angle the character's motions use. The
 * analysis rasterises the real part images (the same pixels the renderer draws) in the parent's
 * frame, rotates the child through the angles its motions and expressions reach, and measures
 * the covered fraction of the joint disk. Rounded "capsule" joints (both parts contain the disk)
 * pass for any angle; butt-jointed rectangles open a wedge-shaped gap when bent.
 *
 * 3D: continuity comes from skin weights; see src/scene3d/skinning.ts (blended/connected/rigid).
 */
import type { Character2D } from "./schema.js";

export interface AlphaImage {
  width: number;
  height: number;
  /** One alpha byte per pixel. */
  alpha: Uint8Array;
}

export interface JointReport2D {
  part: string;
  parent: string;
  /** Relative rotation range (degrees) the character's motions/expressions use at this joint. */
  angles: [number, number];
  /** Joint disk radius in layer units (px at scale 1). */
  radius: number;
  /** Lowest covered fraction of the joint disk over the sampled angles (1 = always closed). */
  coverage: number;
  worstAngle: number;
  status: "continuous" | "gap" | "static";
}

export interface Continuity2D {
  method: "layered parts: joint-disk coverage";
  threshold: number;
  joints: JointReport2D[];
  gaps: string[];
  continuous: boolean;
}

const THRESHOLD = 0.985;
const MAX_RADIUS = 14;

function sampler(img: AlphaImage, part: { width?: number; height?: number; anchorX: number; anchorY: number }) {
  const w = part.width ?? img.width;
  const h = part.height ?? img.height;
  const sx = img.width / w;
  const sy = img.height / h;
  // point in the part's pivot space (layer units) -> alpha 0..255 (nearest pixel)
  return (x: number, y: number) => {
    const px = Math.floor((x + part.anchorX * w) * sx);
    const py = Math.floor((y + part.anchorY * h) * sy);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return 0;
    return img.alpha[py * img.width + px];
  };
}

/** Relative rotation offsets a part reaches in any motion or expression (plus rest = 0). */
function rotationRange(def: Character2D, part: string): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const m of Object.values(def.motions)) {
    const keys = m.tracks[`${part}.rotation`];
    if (keys) for (const [, v] of keys) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  }
  for (const e of Object.values(def.expressions)) {
    const r = e.parts[part]?.rotation;
    if (r !== undefined) (lo = Math.min(lo, r)), (hi = Math.max(hi, r));
  }
  return [lo, hi];
}

export function analyzeJoints2D(def: Character2D, image: (assetName: string) => AlphaImage | undefined): Continuity2D {
  const parts = new Map(def.rig.parts.map((p) => [p.id, p]));
  const joints: JointReport2D[] = [];
  for (const part of def.rig.parts) {
    if (!part.parent || !part.asset) continue;
    const parent = parts.get(part.parent);
    if (!parent?.asset) continue;
    const ci = image(part.asset);
    const pi = image(parent.asset);
    if (!ci || !pi) continue;
    const [lo, hi] = rotationRange(def, part.id);
    const child = sampler(ci, part);
    const par = sampler(pi, parent);
    // joint centre in the parent's pivot space (parentPoint: offset from that attachment point)
    let jx = part.x;
    let jy = part.y;
    if (part.parentPoint && parent.attachmentPoints?.[part.parentPoint]) {
      const ap = parent.attachmentPoints[part.parentPoint];
      const w = parent.width ?? pi.width;
      const h = parent.height ?? pi.height;
      jx += (ap.x - parent.anchorX) * w;
      jy += (ap.y - parent.anchorY) * h;
    }
    // limb half-width at the joint: opaque extent of the child along its own x axis
    // (widest row within 3 units of the pivot: a pivot may sit on the part's edge, e.g. a waist)
    let half = 0;
    for (let dy = -3; dy <= 3; dy += 0.5) {
      let left = 0;
      let right = 0;
      while (left < 60 && child(-(left + 0.5), dy) > 127) left += 0.5;
      while (right < 60 && child(right + 0.5, dy) > 127) right += 0.5;
      half = Math.max(half, Math.min(left, right));
    }
    const radius = Math.min(MAX_RADIUS, Math.max(2, half));
    const moving = hi - lo > 0.01 || part.rotation !== 0;
    const angles = hi - lo > 0.01 ? Array.from({ length: 13 }, (_, i) => lo + ((hi - lo) * i) / 12) : [0];
    let coverage = 1;
    let worstAngle = 0;
    for (const off of angles) {
      const a = ((part.rotation + off) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      let inside = 0;
      let covered = 0;
      for (let y = -radius; y <= radius; y += 0.5) {
        for (let x = -radius; x <= radius; x += 0.5) {
          if (x * x + y * y > radius * radius) continue;
          inside++;
          // parent frame point (joint + (x,y)); child frame = inverse rotation about the pivot
          const inParent = par(jx + x, jy + y) > 127;
          const inChild = child(c * x + s * y, -s * x + c * y) > 127;
          if (inParent || inChild) covered++;
        }
      }
      const cov = inside ? covered / inside : 1;
      if (cov < coverage) (coverage = cov), (worstAngle = +(part.rotation + off).toFixed(1));
    }
    joints.push({
      part: part.id,
      parent: parent.id,
      angles: [+lo.toFixed(1), +hi.toFixed(1)],
      radius: +radius.toFixed(1),
      coverage: +coverage.toFixed(4),
      worstAngle,
      status: !moving ? "static" : coverage >= THRESHOLD ? "continuous" : "gap",
    });
  }
  const gaps = joints.filter((j) => j.status === "gap").map((j) => j.part);
  return { method: "layered parts: joint-disk coverage", threshold: THRESHOLD, joints, gaps, continuous: gaps.length === 0 };
}
