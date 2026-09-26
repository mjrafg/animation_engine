/**
 * Builds the 2D character package "bruno" (a bear cub in a yellow shirt and teal overalls,
 * drawn after a reference illustration) procedurally:
 *
 *   npx tsx assets/characters/src/build-bruno.ts
 *
 * Output: assets/characters/bruno/{character.json, parts/*.png}, assets/characters/props/honey.png.
 * Front view (head turned slightly toward its facing, mirrored by the runtime for "left"), ~360 px
 * tall at scale 1, drawn at 3x. Same part names and sockets as Pip (upper_arm_r, forearm_r,
 * hand_r, ... rightHand/leftHand/head), so every action, interaction and reach works unchanged.
 * Limbs are capsules centred on the joint pivots (continuous at any bend, like Pip).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "bruno");
const PARTS = path.join(OUT, "parts");
const RES = 3;
const INK = "#6a3a1e";
const LW = 3;
const C = {
  fur: "#c98039",
  furShade: "#b56d2c",
  furLight: "#d99450",
  muzzle: "#f5dcb4",
  earIn: "#ecb68c",
  nose: "#4b2a1b",
  shirt: "#f7d774",
  shirtShade: "#ecc55c",
  overalls: "#5b9791",
  overallsDark: "#4b8580",
  button: "#b9773c",
  pad: "#8c4f2b",
  eye: "#2b1911",
  mouth: "#7a2e1f",
  tongue: "#e57a6a",
};

type Draw = (ctx: SKRSContext2D) => void;
const sizes: Record<string, { w: number; h: number }> = {};

function png(dir: string, name: string, w: number, h: number, draw: Draw) {
  const c = createCanvas(Math.ceil(w * RES), Math.ceil(h * RES));
  const ctx = c.getContext("2d");
  ctx.scale(RES, RES);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  draw(ctx);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.png`), c.toBuffer("image/png"));
  sizes[name] = { w, h };
}
const part = (name: string, w: number, h: number, draw: Draw) => png(PARTS, name, w, h, draw);

function fillStroke(ctx: SKRSContext2D, fill: string | null, stroke: string | null = INK, lw = LW) {
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}
function circle(ctx: SKRSContext2D, x: number, y: number, r: number, fill: string | null, stroke: string | null = INK, lw = LW) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  fillStroke(ctx, fill, stroke, lw);
}
function ellipse(ctx: SKRSContext2D, x: number, y: number, rx: number, ry: number, fill: string | null, stroke: string | null = INK, lw = LW, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  fillStroke(ctx, fill, stroke, lw);
}
function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | null, stroke: string | null = INK, lw = LW) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  fillStroke(ctx, fill, stroke, lw);
}
function line(ctx: SKRSContext2D, color: string, lw: number, fn: () => void, dash?: number[]) {
  ctx.beginPath();
  fn();
  ctx.setLineDash(dash ?? []);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
  ctx.setLineDash([]);
}
/** A soft, slightly tufted fur outline around a circle (the reference's fuzzy cheeks). */
function furryCircle(ctx: SKRSContext2D, x: number, y: number, rx: number, ry: number, tufts: number[], fill: string) {
  ctx.beginPath();
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    let bump = 0;
    for (const t of tufts) {
      const d = Math.atan2(Math.sin(a - t), Math.cos(a - t));
      bump += Math.max(0, 1 - Math.abs(d) / 0.09) * 3.2 * (i % 2 ? 1 : 0.4);
    }
    const px = x + Math.cos(a) * (rx + bump);
    const py = y + Math.sin(a) * (ry + bump);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  fillStroke(ctx, fill);
}

// ---- limbs: capsules centred on the joint pivots ----------------------------------------------------
const MARGIN = 4;
const joints: Record<string, { pivot: { x: number; y: number }; len: number }> = {};

function capsule(ctx: SKRSContext2D, cx: number, y0: number, len: number, r0: number, r1: number, fill: string, outlineStart: boolean, outlineEnd = true) {
  const y1 = y0 + len;
  ctx.beginPath();
  ctx.arc(cx, y0, r0, Math.PI, 0);
  ctx.lineTo(cx + r1, y1);
  ctx.arc(cx, y1, r1, 0, Math.PI);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = LW;
  ctx.beginPath();
  if (outlineStart) {
    ctx.arc(cx, y0, r0, Math.PI, 0);
    ctx.lineTo(cx + r1, y1);
  } else {
    ctx.moveTo(cx + r0, y0);
    ctx.lineTo(cx + r1, y1);
  }
  if (outlineEnd) ctx.arc(cx, y1, r1, 0, Math.PI);
  else ctx.moveTo(cx - r1, y1);
  ctx.lineTo(cx - r0, y0);
  ctx.stroke();
}

function segment(name: string, len: number, rMax: number, draw: (ctx: SKRSContext2D, cx: number, y0: number) => void, below = 0) {
  const w = 2 * rMax + 2 * MARGIN;
  const h = MARGIN + rMax + len + rMax + below + MARGIN;
  const cx = w / 2;
  const y0 = MARGIN + rMax;
  part(name, w, h, (ctx) => draw(ctx, cx, y0));
  joints[name] = { pivot: { x: cx, y: y0 }, len };
}

const UPPER = 34;
const LOWER = 32;
const THIGH = 34;
const SHIN = 30;

segment("upper_arm", UPPER, 17, (ctx, cx, y0) => {
  capsule(ctx, cx, y0, UPPER, 13, 12.5, C.fur, true);
  // short yellow sleeve over the shoulder
  capsule(ctx, cx, y0, 14, 17, 15.5, C.shirt, true);
  line(ctx, C.shirtShade, 2, () => (ctx.moveTo(cx - 13, y0 + 22), ctx.quadraticCurveTo(cx, y0 + 26, cx + 13, y0 + 22)));
});
segment("forearm", LOWER, 12.5, (ctx, cx, y0) => capsule(ctx, cx, y0, LOWER, 12.5, 12, C.fur, false));
const HAND_R = 15;
segment("hand", 9, HAND_R, (ctx, cx, y0) => {
  circle(ctx, cx, y0, 12, C.fur, null); // wrist disk: continues the forearm end
  ellipse(ctx, cx, y0 + 9, HAND_R, HAND_R - 1, C.fur);
  // curled fingers
  for (const dx of [-5, 1, 7]) line(ctx, INK, 2, () => (ctx.moveTo(cx + dx, y0 + 18), ctx.lineTo(cx + dx - 1, y0 + 22)));
});
segment(
  "hand_open",
  9,
  18,
  (ctx, cx, y0) => {
    circle(ctx, cx, y0, 12, C.fur, null);
    // open paw seen from the front, palm pads showing (as in the reference wave)
    ctx.beginPath();
    ctx.ellipse(cx, y0 + 12, 17, 19, 0, 0, Math.PI * 2);
    fillStroke(ctx, C.fur);
    ellipse(ctx, cx + 1, y0 + 17, 8, 7, C.pad, null);
    ellipse(ctx, cx - 8, y0 + 4, 3.6, 4.2, C.pad, null);
    ellipse(ctx, cx, y0 + 1, 3.6, 4.2, C.pad, null);
    ellipse(ctx, cx + 8, y0 + 4, 3.6, 4.2, C.pad, null);
  },
  6,
);
segment("thigh", THIGH, 21, (ctx, cx, y0) => {
  capsule(ctx, cx, y0, THIGH, 20, 19, C.overalls, true);
  // rolled cuff at the knee
  rr(ctx, cx - 21, y0 + THIGH - 9, 42, 14, 6, C.overalls);
  line(ctx, INK, 1.6, () => (ctx.moveTo(cx - 19, y0 + THIGH - 2), ctx.lineTo(cx + 19, y0 + THIGH - 2)));
});
segment("shin", SHIN, 16, (ctx, cx, y0) => capsule(ctx, cx, y0, SHIN, 16, 15, C.fur, false));
{
  // foot: a round bear foot seen from the front (toe lines), ankle disk continues the shin
  const w = 50;
  const h = 34;
  part("foot", w, h, (ctx) => {
    const ax = 25;
    const ay = 10;
    circle(ctx, ax, ay, 15, C.fur, null);
    ctx.beginPath();
    ctx.moveTo(ax - 22, ay + 16);
    ctx.quadraticCurveTo(ax - 22, ay + 2, ax - 12, ay + 1);
    ctx.lineTo(ax + 12, ay + 1);
    ctx.quadraticCurveTo(ax + 22, ay + 2, ax + 22, ay + 16);
    ctx.quadraticCurveTo(ax + 22, ay + 23, ax + 14, ay + 23);
    ctx.lineTo(ax - 14, ay + 23);
    ctx.quadraticCurveTo(ax - 22, ay + 23, ax - 22, ay + 16);
    ctx.closePath();
    fillStroke(ctx, C.fur);
    for (const dx of [-8, 0, 8]) line(ctx, INK, 2, () => (ctx.moveTo(ax + dx, ay + 23), ctx.lineTo(ax + dx, ay + 17)));
  });
  joints.foot = { pivot: { x: 25, y: 10 }, len: 0 };
}

// ---- body -------------------------------------------------------------------------------------------
part("pelvis", 124, 62, (ctx) => {
  // the seat of the overalls
  ctx.beginPath();
  ctx.moveTo(8, 4);
  ctx.lineTo(116, 4);
  ctx.quadraticCurveTo(122, 30, 112, 56);
  ctx.lineTo(12, 56);
  ctx.quadraticCurveTo(2, 30, 8, 4);
  ctx.closePath();
  fillStroke(ctx, C.overalls);
  line(ctx, INK, 2, () => (ctx.moveTo(62, 8), ctx.quadraticCurveTo(63, 34, 60, 56)));
  line(ctx, C.overallsDark, 2, () => (ctx.moveTo(18, 18), ctx.quadraticCurveTo(26, 36, 22, 50)));
});
part("torso", 128, 100, (ctx) => {
  // yellow shirt: round shoulders, a little belly
  ctx.beginPath();
  ctx.moveTo(34, 8);
  ctx.quadraticCurveTo(64, 0, 94, 8);
  ctx.quadraticCurveTo(116, 16, 118, 44);
  ctx.quadraticCurveTo(124, 80, 116, 98);
  ctx.lineTo(12, 98);
  ctx.quadraticCurveTo(4, 80, 10, 44);
  ctx.quadraticCurveTo(12, 16, 34, 8);
  ctx.closePath();
  fillStroke(ctx, C.shirt);
  line(ctx, C.shirtShade, 2.2, () => (ctx.moveTo(44, 12), ctx.quadraticCurveTo(64, 20, 84, 12))); // collar
  // overall bib + straps
  ctx.beginPath();
  ctx.moveTo(30, 44);
  ctx.lineTo(98, 44);
  ctx.quadraticCurveTo(108, 72, 112, 98);
  ctx.lineTo(16, 98);
  ctx.quadraticCurveTo(20, 72, 30, 44);
  ctx.closePath();
  fillStroke(ctx, C.overalls);
  rr(ctx, 24, 6, 14, 42, 6, C.overalls);
  rr(ctx, 90, 6, 14, 42, 6, C.overalls);
  circle(ctx, 33, 46, 6, C.button, INK, 2);
  circle(ctx, 95, 46, 6, C.button, INK, 2);
  for (const [bx, by] of [
    [33, 46],
    [95, 46],
  ] as const) {
    for (const [ox, oy] of [
      [-1.6, -1.6],
      [1.6, -1.6],
      [-1.6, 1.6],
      [1.6, 1.6],
    ])
      circle(ctx, bx + ox, by + oy, 0.8, INK, null);
  }
  // front pocket with stitching
  rr(ctx, 44, 58, 44, 30, 5, C.overalls, INK, 2.2);
  line(ctx, C.overallsDark, 1.4, () => ctx.roundRect(47, 61, 38, 24, 4), [3, 3]);
  line(ctx, INK, 2, () => (ctx.moveTo(44, 66), ctx.lineTo(88, 66)));
});

// head: round, big ears with light insides, a tuft on top, cream muzzle turned slightly toward
// its facing (+x) like the reference's three-quarter look
part("head", 184, 176, (ctx) => {
  circle(ctx, 32, 46, 27, C.fur);
  circle(ctx, 32, 48, 15, C.earIn, null);
  circle(ctx, 152, 42, 27, C.fur);
  circle(ctx, 152, 44, 15, C.earIn, null);
  furryCircle(ctx, 92, 96, 76, 72, [2.7, 2.9, 3.1, 0.15, 0.35, 0.55], C.fur);
  // tuft
  for (const [dx, h, r] of [
    [-10, 16, -0.5],
    [0, 20, 0],
    [10, 15, 0.5],
  ] as const) {
    ctx.save();
    ctx.translate(92 + dx, 28);
    ctx.rotate(r);
    ctx.beginPath();
    ctx.ellipse(0, -h / 2, 5, h / 2 + 2, 0, 0, Math.PI * 2);
    fillStroke(ctx, C.fur, INK, 2.4);
    ctx.restore();
  }
  ctx.beginPath(); // re-cover the tuft bases
  ctx.ellipse(92, 40, 22, 12, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.fur;
  ctx.fill();
  // light fur on the cheeks and a soft muzzle
  ellipse(ctx, 104, 124, 36, 27, C.muzzle, INK, 2.4);
  ellipse(ctx, 108, 110, 13, 9.5, C.nose, INK, 2);
  ellipse(ctx, 104, 106, 4, 2.4, "rgba(255,255,255,0.55)", null, 0, -0.3);
  line(ctx, INK, 2.2, () => (ctx.moveTo(108, 119), ctx.lineTo(108, 126)));
  // blush
  ellipse(ctx, 62, 122, 10, 6, "rgba(230,120,90,0.25)", null);
  ellipse(ctx, 146, 118, 9, 6, "rgba(230,120,90,0.25)", null);
});

// ---- face -------------------------------------------------------------------------------------------
const EYES = { w: 96, h: 40 };
const eye = (ctx: SKRSContext2D, x: number, y: number, rx: number, ry: number) => {
  ellipse(ctx, x, y, rx, ry, C.eye, null);
  ellipse(ctx, x + rx * 0.35, y - ry * 0.35, rx * 0.34, ry * 0.26, "#ffffff", null);
  ellipse(ctx, x - rx * 0.3, y + ry * 0.4, rx * 0.15, ry * 0.1, "rgba(255,255,255,0.7)", null);
};
part("eyes_open", EYES.w, EYES.h, (ctx) => {
  eye(ctx, 22, 22, 9, 12);
  eye(ctx, 70, 20, 10, 13);
});
part("eyes_wide", EYES.w, EYES.h, (ctx) => {
  eye(ctx, 22, 21, 11, 14.5);
  eye(ctx, 70, 19, 12, 15.5);
});
part("eyes_closed", EYES.w, EYES.h, (ctx) => {
  line(ctx, INK, 3, () => (ctx.moveTo(13, 22), ctx.quadraticCurveTo(22, 29, 31, 22)));
  line(ctx, INK, 3, () => (ctx.moveTo(60, 21), ctx.quadraticCurveTo(70, 28, 80, 21)));
});
part("eyes_happy", EYES.w, EYES.h, (ctx) => {
  line(ctx, INK, 3.2, () => (ctx.moveTo(13, 25), ctx.quadraticCurveTo(22, 14, 31, 25)));
  line(ctx, INK, 3.2, () => (ctx.moveTo(60, 24), ctx.quadraticCurveTo(70, 13, 80, 24)));
});
const BROWS = { w: 96, h: 22 };
part("brows", BROWS.w, BROWS.h, (ctx) => {
  // one brow a little raised: the reference's curious look
  line(ctx, INK, 2.6, () => (ctx.moveTo(12, 16), ctx.quadraticCurveTo(21, 10, 30, 13)));
  line(ctx, INK, 2.6, () => (ctx.moveTo(60, 11), ctx.quadraticCurveTo(70, 6, 80, 10)));
});
part("brows_up", BROWS.w, BROWS.h, (ctx) => {
  line(ctx, INK, 2.6, () => (ctx.moveTo(12, 11), ctx.quadraticCurveTo(21, 4, 30, 8)));
  line(ctx, INK, 2.6, () => (ctx.moveTo(60, 7), ctx.quadraticCurveTo(70, 2, 80, 6)));
});
part("brows_sad", BROWS.w, BROWS.h, (ctx) => {
  line(ctx, INK, 2.6, () => (ctx.moveTo(12, 16), ctx.lineTo(30, 9)));
  line(ctx, INK, 2.6, () => (ctx.moveTo(62, 9), ctx.lineTo(80, 16)));
});
part("brows_happy", BROWS.w, BROWS.h, (ctx) => {
  line(ctx, INK, 2.6, () => (ctx.moveTo(12, 14), ctx.quadraticCurveTo(21, 7, 30, 13)));
  line(ctx, INK, 2.6, () => (ctx.moveTo(60, 12), ctx.quadraticCurveTo(70, 5, 80, 12)));
});

const M = { w: 44, h: 32 };
const mx = 22;
const my = 10;
const openShape = (ctx: SKRSContext2D, rx: number, ry: number, teeth: boolean, tongue: boolean) => {
  ctx.beginPath();
  ctx.ellipse(mx, my, rx, 1.5, 0, Math.PI, 0);
  ctx.ellipse(mx, my, rx, ry, 0, 0, Math.PI);
  ctx.closePath();
  ctx.save();
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.clip();
  if (teeth) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(mx - rx, my - 1, rx * 2, Math.min(4, ry / 2));
  }
  if (tongue) {
    ctx.fillStyle = C.tongue;
    ctx.beginPath();
    ctx.ellipse(mx, my + ry, rx * 0.6, ry * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.4;
  ctx.stroke();
};
part("mouth_rest", M.w, M.h, (ctx) => line(ctx, INK, 2.8, () => (ctx.moveTo(10, 8), ctx.quadraticCurveTo(22, 17, 34, 8))));
part("mouth_MBP", M.w, M.h, (ctx) => line(ctx, INK, 3.4, () => (ctx.moveTo(12, 10), ctx.quadraticCurveTo(22, 12, 32, 10))));
part("mouth_AI", M.w, M.h, (ctx) => openShape(ctx, 11, 13, true, true));
part("mouth_E", M.w, M.h, (ctx) => openShape(ctx, 13, 7, true, false));
part("mouth_O", M.w, M.h, (ctx) => ellipse(ctx, mx, 13, 7, 9, C.mouth, INK, 2.4));
part("mouth_U", M.w, M.h, (ctx) => ellipse(ctx, mx, 13, 4.5, 5.5, C.mouth, INK, 2.6));
part("mouth_FV", M.w, M.h, (ctx) => {
  openShape(ctx, 10, 5, true, false);
  line(ctx, INK, 2.2, () => (ctx.moveTo(12, 15), ctx.quadraticCurveTo(22, 12, 32, 15)));
});
part("mouth_L", M.w, M.h, (ctx) => openShape(ctx, 10, 9, false, true));
part("mouth_smile", M.w, M.h, (ctx) => line(ctx, INK, 3, () => (ctx.moveTo(6, 6), ctx.quadraticCurveTo(22, 22, 38, 6))));
part("mouth_smile_AI", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(6, 5);
  ctx.lineTo(38, 5);
  ctx.quadraticCurveTo(35, 29, 22, 28);
  ctx.quadraticCurveTo(9, 29, 6, 5);
  ctx.closePath();
  fillStroke(ctx, C.mouth, INK, 2.4);
  ctx.fillStyle = C.tongue;
  ctx.beginPath();
  ctx.ellipse(22, 23, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
});
part("mouth_smile_E", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(6, 6);
  ctx.lineTo(38, 6);
  ctx.quadraticCurveTo(33, 19, 22, 19);
  ctx.quadraticCurveTo(11, 19, 6, 6);
  ctx.closePath();
  fillStroke(ctx, C.mouth, INK, 2.4);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(9, 7, 26, 4);
});
part("mouth_sad", M.w, M.h, (ctx) => line(ctx, INK, 3, () => (ctx.moveTo(10, 16), ctx.quadraticCurveTo(22, 6, 34, 16))));
part("mouth_O_big", M.w, M.h, (ctx) => ellipse(ctx, mx, 14, 9, 11, C.mouth, INK, 2.4));

// ---- prop: honey pot -------------------------------------------------------------------------------
png(path.join(HERE, "..", "props"), "honey", 44, 46, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(10, 14);
  ctx.quadraticCurveTo(2, 22, 5, 34);
  ctx.quadraticCurveTo(8, 44, 22, 44);
  ctx.quadraticCurveTo(36, 44, 39, 34);
  ctx.quadraticCurveTo(42, 22, 34, 14);
  ctx.closePath();
  fillStroke(ctx, "#e9a23b", "#7a4a1c", 2.4);
  rr(ctx, 8, 7, 28, 9, 4, "#c77e2a", "#7a4a1c", 2.4);
  ctx.beginPath(); // label
  ctx.roundRect(12, 22, 20, 12, 3);
  fillStroke(ctx, "#fff4d6", "#7a4a1c", 1.6);
  // a little bee instead of lettering: reads the same when the pot is mirrored
  ellipse(ctx, 22, 28, 4.6, 3.4, "#ffd23f", "#7a4a1c", 1.2);
  line(ctx, "#7a4a1c", 1.4, () => (ctx.moveTo(21, 25), ctx.lineTo(21, 31)));
  line(ctx, "#7a4a1c", 1.4, () => (ctx.moveTo(24, 25.5), ctx.lineTo(24, 30.5)));
  ellipse(ctx, 20, 24.5, 2.2, 1.6, "rgba(200,235,255,0.95)", "#7a4a1c", 0.8);
  ellipse(ctx, 24, 24.5, 2.2, 1.6, "rgba(200,235,255,0.95)", "#7a4a1c", 0.8);
  ctx.beginPath(); // drip
  ctx.moveTo(14, 16);
  ctx.quadraticCurveTo(15, 22, 17, 16);
  ctx.fillStyle = "#f4b545";
  ctx.fill();
  ellipse(ctx, 30, 19, 2, 4, "rgba(255,255,255,0.45)", null);
});

// ---- definition ---------------------------------------------------------------------------------------
const S = (name: string) => ({ width: sizes[name].w, height: sizes[name].h });
const assets = Object.fromEntries(Object.keys(sizes).filter((n) => n !== "honey").map((n) => [n, `parts/${n}.png`]));
const anchor = (name: string) => ({ anchorX: joints[name].pivot.x / sizes[name].w, anchorY: joints[name].pivot.y / sizes[name].h });

// rest pose (root at the feet): ankles -22, knees -52, hips (joint) -86, pelvis pivot -100,
// torso bottom -104, shoulders -188, neck -196
const arm = (side: "r" | "l", sx: number, z: number) => [
  { id: `upper_arm_${side}`, asset: "upper_arm", parent: "torso", x: sx, y: -84, rotation: side === "r" ? 6 : -6, ...S("upper_arm"), ...anchor("upper_arm"), z },
  { id: `forearm_${side}`, asset: "forearm", parent: `upper_arm_${side}`, x: 0, y: UPPER, rotation: side === "r" ? -4 : 4, ...S("forearm"), ...anchor("forearm"), z: z + 0.1 },
  {
    id: `hand_${side}`,
    asset: "hand",
    parent: `forearm_${side}`,
    x: 0,
    y: LOWER,
    ...S("hand"),
    ...anchor("hand"),
    z: z + 0.2,
    attachmentPoints: { grip: { x: 0.5, y: (joints.hand.pivot.y + 10) / sizes.hand.h } },
  },
];
const leg = (side: "r" | "l", sx: number, z: number) => [
  { id: `thigh_${side}`, asset: "thigh", parent: "hips", x: sx, y: 14, ...S("thigh"), ...anchor("thigh"), z },
  { id: `shin_${side}`, asset: "shin", parent: `thigh_${side}`, x: 0, y: THIGH, ...S("shin"), ...anchor("shin"), z: z + 0.1 },
  { id: `foot_${side}`, asset: "foot", parent: `shin_${side}`, x: 0, y: SHIN, ...S("foot"), ...anchor("foot"), z: z + 0.2 },
];

const def = {
  id: "bruno",
  name: "Bruno the bear",
  version: 1,
  kind: "2d",
  description:
    "Bear cub in a yellow shirt and teal overalls (front view, head turned a little toward its facing; mirrored for left). ~360 px tall at scale 1. Actions: walk (waddle), run, wave, cheer, point, shy, look; expressions smile, happy, sad, surprised; full lip sync and blinks.",
  assets,
  rig: {
    facing: "right",
    height: 360,
    parts: [
      ...leg("r", -26, 4),
      ...leg("l", 26, 4),
      { id: "hips", asset: "pelvis", x: 0, y: -100, ...S("pelvis"), anchorX: 0.5, anchorY: 0.23, z: 8 },
      { id: "torso", asset: "torso", parent: "hips", x: 0, y: -4, ...S("torso"), anchorX: 0.5, anchorY: 1, z: 10 },
      { id: "head", asset: "head", parent: "torso", x: 2, y: -92, ...S("head"), anchorX: 0.5, anchorY: 0.95, z: 14, attachmentPoints: { top: { x: 0.5, y: 0.1 } } },
      { id: "brows", asset: "brows", parent: "head", x: 8, y: -122, ...S("brows"), z: 15 },
      { id: "eyes", asset: "eyes_open", parent: "head", x: 8, y: -96, ...S("eyes_open"), z: 15 },
      { id: "mouth", asset: "mouth_rest", parent: "head", x: 16, y: -30, ...S("mouth_rest"), z: 15 },
      ...arm("r", -54, 16),
      ...arm("l", 54, 16),
    ],
  },
  sockets: {
    rightHand: { part: "hand_r", point: "grip" },
    leftHand: { part: "hand_l", point: "grip" },
    head: { part: "head", point: "top" },
  },
  motions: {
    idle: {
      duration: 2.6,
      tracks: {
        "torso.rotation": [[0, 0], [1.3, 1.4]],
        "torso.scaleY": [[0, 0], [1.3, 0.015]],
        "head.rotation": [[0, 0], [1.3, -2.5]],
        "upper_arm_r.rotation": [[0, 1.5], [1.3, -1.5]],
        "upper_arm_l.rotation": [[0, -1.5], [1.3, 1.5]],
        "hips.y": [[0, 0], [1.3, 1.5]],
      },
    },
    walk: {
      // a cheerful front-view waddle: legs lift in turn, body rocks, arms swing
      duration: 0.72,
      tracks: {
        "thigh_r.y": [[0, 0], [0.18, -10], [0.36, 0]],
        "thigh_l.y": [[0, 0], [0.36, 0], [0.54, -10]],
        "thigh_r.rotation": [[0, 0], [0.18, 6], [0.36, 0]],
        "thigh_l.rotation": [[0, 0], [0.36, 0], [0.54, -6]],
        "shin_r.rotation": [[0, 0], [0.18, -8], [0.36, 0]],
        "shin_l.rotation": [[0, 0], [0.36, 0], [0.54, 8]],
        "hips.y": [[0, 0], [0.18, -4], [0.36, 0], [0.54, -4]],
        "hips.rotation": [[0, -3], [0.36, 3]],
        "torso.rotation": [[0, 3], [0.36, -3]],
        "head.rotation": [[0, -3], [0.36, 3]],
        "upper_arm_r.rotation": [[0, 16], [0.36, -6]],
        "upper_arm_l.rotation": [[0, 6], [0.36, -16]],
        "forearm_r.rotation": [[0, -10], [0.36, -2]],
        "forearm_l.rotation": [[0, 2], [0.36, 10]],
      },
    },
    run: {
      duration: 0.44,
      tracks: {
        "thigh_r.y": [[0, 0], [0.11, -16], [0.22, 0]],
        "thigh_l.y": [[0, 0], [0.22, 0], [0.33, -16]],
        "shin_r.rotation": [[0, 0], [0.11, -14], [0.22, 0]],
        "shin_l.rotation": [[0, 0], [0.22, 0], [0.33, 14]],
        "hips.y": [[0, 0], [0.11, -10], [0.22, 0], [0.33, -10]],
        "hips.rotation": [[0, -4], [0.22, 4]],
        "torso.rotation": [[0, 7], [0.22, 3]],
        "head.rotation": [[0, -4]],
        "upper_arm_r.rotation": [[0, 40], [0.22, 10]],
        "upper_arm_l.rotation": [[0, -10], [0.22, -40]],
        "forearm_r.rotation": [[0, -50]],
        "forearm_l.rotation": [[0, 50]],
      },
    },
    wave: {
      // right paw up beside the head, waving (the reference pose)
      duration: 0.7,
      blend: 0.25,
      tracks: {
        "upper_arm_r.rotation": [[0, 112]],
        "forearm_r.rotation": [[0, 52], [0.35, 82]],
        "head.rotation": [[0, -5]],
      },
      assets: { hand_r: "hand_open" },
    },
    cheer: {
      duration: 0.5,
      blend: 0.2,
      tracks: {
        "upper_arm_r.rotation": [[0, 150], [0.25, 158]],
        "upper_arm_l.rotation": [[0, -150], [0.25, -158]],
        "forearm_r.rotation": [[0, 14], [0.25, 4]],
        "forearm_l.rotation": [[0, -14], [0.25, -4]],
        "hips.y": [[0, 0], [0.25, -10]],
        "head.rotation": [[0, 0]],
      },
      assets: { hand_r: "hand_open", hand_l: "hand_open" },
    },
    point: {
      duration: 0.35,
      loop: false,
      blend: 0.15,
      tracks: { "upper_arm_l.rotation": [[0, -20], [0.35, -86]], "forearm_l.rotation": [[0, 0], [0.35, -6]] },
    },
    shy: {
      // paws together in front of the belly, head tilted
      duration: 1.6,
      blend: 0.3,
      tracks: {
        "upper_arm_r.rotation": [[0, -24]],
        "upper_arm_l.rotation": [[0, 24]],
        "forearm_r.rotation": [[0, -46]],
        "forearm_l.rotation": [[0, 46]],
        "head.rotation": [[0, 7], [0.8, 9]],
        "torso.rotation": [[0, 2]],
      },
    },
    look_up: { duration: 0.3, loop: false, tracks: { "head.rotation": [[0, -8]], "head.y": [[0, -3]] } },
    look_down: { duration: 0.3, loop: false, tracks: { "head.rotation": [[0, 6]], "head.y": [[0, 3]] } },
  },
  expressions: {
    smile: { parts: { brows: { asset: "brows_happy", y: -2 } }, mouthSet: "smile" },
    happy: { parts: { brows: { asset: "brows_happy", y: -3 }, eyes: { asset: "eyes_happy" } }, mouthSet: "smile" },
    sad: { parts: { brows: { asset: "brows_sad" }, head: { rotation: 4 } }, mouthSet: "sad" },
    surprised: { parts: { brows: { asset: "brows_up", y: -4 }, eyes: { asset: "eyes_wide" } }, mouthSet: "surprised" },
  },
  mouth: {
    part: "mouth",
    sets: {
      neutral: { rest: "mouth_rest", MBP: "mouth_MBP", AI: "mouth_AI", E: "mouth_E", O: "mouth_O", U: "mouth_U", FV: "mouth_FV", L: "mouth_L" },
      smile: { rest: "mouth_smile", MBP: "mouth_smile", AI: "mouth_smile_AI", E: "mouth_smile_E" },
      sad: { rest: "mouth_sad" },
      surprised: { rest: "mouth_O_big" },
    },
  },
  eyes: { part: "eyes", open: "eyes_open", closed: "eyes_closed" },
  actions: {
    walk: { kind: "locomotion", motion: "walk", speed: 150, description: "Front-view waddle; moves the character." },
    run: { kind: "locomotion", motion: "run", speed: 340, description: "Quick bouncy run." },
    wave: { kind: "gesture", motion: "wave", description: "Raises the right paw beside the head and waves." },
    cheer: { kind: "gesture", motion: "cheer", description: "Both paws up, bouncing." },
    point: { kind: "gesture", motion: "point", description: "Points toward its facing with the left paw and holds." },
    shy: { kind: "gesture", motion: "shy", description: "Paws together in front of the belly, head tilted." },
    look: { kind: "look", motions: { up: "look_up", down: "look_down" }, description: "Looks up/down (forward = back to normal)." },
  },
  defaults: { blend: 0.2, turnTime: 0.2, blinkDuration: 0.15, autoBlinkInterval: 3.0, facing: "right" },
};
fs.writeFileSync(path.join(OUT, "character.json"), JSON.stringify(def, null, 2) + "\n");
console.log(`bruno: ${Object.keys(assets).length} parts, ${def.rig.parts.length} rig parts -> ${path.relative(process.cwd(), OUT)}`);
