/**
 * Builds the reusable 2D test character package "pip" (and a mug prop) procedurally:
 *
 *   npx tsx assets/characters/src/build-pip.ts
 *
 * Output: assets/characters/pip/{character.json, parts/*.png}, assets/characters/props/mug.png.
 * This is the one-time PREPARATION of the character: rig (parts, pivots, parent chain, sockets),
 * reusable motion presets (idle, walk, run, wave, point, look), expressions, a full viseme mouth
 * set (+ smile/sad/surprised variants) and blink eyes. Everything later only USES it.
 *
 * Art: a side-view cartoon kid facing right (mirrored by the runtime for "left"). Drawn at 2x.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "pip");
const PARTS = path.join(OUT, "parts");
const RES = 2;
const INK = "#35231c";
const C = { skin: "#f4c49d", skinShade: "#dfa57c", shirt: "#3a86c8", shirtDark: "#2c6aa2", shorts: "#2f3e57", shoe: "#c0392b", hair: "#5b3a29", lip: "#a8352e", mouth: "#6b1f1f", tongue: "#e3706a" };

type Draw = (ctx: SKRSContext2D) => void;
const sizes: Record<string, { w: number; h: number }> = {};

function png(dir: string, name: string, w: number, h: number, draw: Draw) {
  const c = createCanvas(w * RES, h * RES);
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

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke: string | null = INK, lw = 2.2) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}
function circle(ctx: SKRSContext2D, x: number, y: number, r: number, fill: string, stroke: string | null = INK, lw = 2.2) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
}
function stroke(ctx: SKRSContext2D, color: string, lw: number, pathFn: () => void) {
  ctx.beginPath();
  pathFn();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.stroke();
}

// ---- body parts ---------------------------------------------------------------------------------
part("pelvis", 56, 32, (ctx) => rr(ctx, 3, 3, 50, 26, 10, C.shorts));
part("torso", 60, 86, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(12, 6);
  ctx.quadraticCurveTo(30, 0, 48, 6);
  ctx.quadraticCurveTo(58, 12, 56, 40);
  ctx.lineTo(55, 84);
  ctx.lineTo(5, 84);
  ctx.lineTo(4, 34);
  ctx.quadraticCurveTo(4, 10, 12, 6);
  ctx.closePath();
  ctx.fillStyle = C.shirt;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = C.shirtDark;
  ctx.fillRect(6, 74, 48, 8);
  circle(ctx, 40, 34, 7, "#ffd23f", null); // star badge
});
part("head", 104, 108, (ctx) => {
  rr(ctx, 40, 86, 18, 22, 6, C.skinShade, null); // neck
  circle(ctx, 54, 56, 44, C.skin);
  // nose (points right)
  ctx.beginPath();
  ctx.arc(97, 62, 7, -1.4, 1.4);
  ctx.fillStyle = C.skin;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  // hair
  ctx.fillStyle = C.hair;
  ctx.beginPath();
  ctx.moveTo(10, 66);
  ctx.quadraticCurveTo(4, 8, 58, 8);
  ctx.quadraticCurveTo(98, 10, 98, 40);
  ctx.quadraticCurveTo(76, 26, 58, 34);
  ctx.quadraticCurveTo(40, 42, 34, 64);
  ctx.closePath();
  ctx.fill();
  // ear
  circle(ctx, 34, 64, 8, C.skin);
  // cheek
  ctx.fillStyle = "rgba(240,110,110,0.33)";
  ctx.beginPath();
  ctx.ellipse(74, 76, 9, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
});
part("upper_arm", 20, 48, (ctx) => {
  rr(ctx, 3, 2, 14, 44, 7, C.skin);
  rr(ctx, 1, 0, 18, 20, 8, C.shirt);
});
part("forearm", 18, 44, (ctx) => rr(ctx, 2, 1, 14, 42, 7, C.skin));
part("hand", 20, 20, (ctx) => circle(ctx, 10, 10, 8, C.skin));
part("hand_open", 24, 28, (ctx) => {
  circle(ctx, 12, 10, 8, C.skin);
  for (const dx of [-6, -2, 2, 6]) stroke(ctx, INK, 2, () => (ctx.moveTo(12 + dx, 14), ctx.lineTo(12 + dx * 1.4, 25)));
  for (const dx of [-6, -2, 2, 6]) stroke(ctx, C.skin, 3, () => (ctx.moveTo(12 + dx, 13), ctx.lineTo(12 + dx * 1.4, 24)));
});
part("hand_point", 20, 34, (ctx) => {
  circle(ctx, 10, 10, 8, C.skin);
  rr(ctx, 7, 12, 6, 20, 3, C.skin);
});
part("thigh", 22, 64, (ctx) => {
  rr(ctx, 3, 2, 16, 60, 8, C.skin);
  rr(ctx, 1, 0, 20, 28, 8, C.shorts);
});
part("shin", 20, 62, (ctx) => {
  rr(ctx, 3, 1, 14, 58, 7, C.skin);
  rr(ctx, 3, 46, 14, 9, 3, "#ffffff", INK, 1.6);
});
part("foot", 38, 16, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(2, 2);
  ctx.lineTo(22, 2);
  ctx.quadraticCurveTo(36, 3, 36, 12);
  ctx.lineTo(36, 14);
  ctx.lineTo(2, 14);
  ctx.closePath();
  ctx.fillStyle = C.shoe;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2;
  ctx.stroke();
});

// ---- face ---------------------------------------------------------------------------------------
const EYES = { w: 40, h: 22 };
const eye = (ctx: SKRSContext2D, x: number, r: number) => {
  circle(ctx, x, 11, r, "#ffffff", INK, 1.8);
  circle(ctx, x + 2, 12, r * 0.55, "#2b2b36", null);
  circle(ctx, x + 3, 10, r * 0.2, "#ffffff", null);
};
part("eyes_open", EYES.w, EYES.h, (ctx) => {
  eye(ctx, 9, 6.5);
  eye(ctx, 28, 8);
});
part("eyes_wide", EYES.w, EYES.h, (ctx) => {
  eye(ctx, 9, 8);
  eye(ctx, 28, 9.8);
});
part("eyes_closed", EYES.w, EYES.h, (ctx) => {
  stroke(ctx, INK, 2.4, () => (ctx.moveTo(3, 12), ctx.quadraticCurveTo(9, 16, 15, 12)));
  stroke(ctx, INK, 2.4, () => (ctx.moveTo(20, 12), ctx.quadraticCurveTo(28, 17, 36, 12)));
});
const BROWS = { w: 42, h: 14 };
part("brows", BROWS.w, BROWS.h, (ctx) => {
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(3, 9), ctx.quadraticCurveTo(9, 6, 15, 8)));
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(21, 8), ctx.quadraticCurveTo(29, 5, 37, 8)));
});
part("brows_up", BROWS.w, BROWS.h, (ctx) => {
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(3, 7), ctx.quadraticCurveTo(9, 2, 15, 5)));
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(21, 5), ctx.quadraticCurveTo(29, 1, 37, 5)));
});
part("brows_sad", BROWS.w, BROWS.h, (ctx) => {
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(3, 11), ctx.lineTo(15, 5)));
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(21, 5), ctx.lineTo(37, 11)));
});
part("brows_happy", BROWS.w, BROWS.h, (ctx) => {
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(3, 10), ctx.quadraticCurveTo(9, 4, 15, 9)));
  stroke(ctx, C.hair, 3, () => (ctx.moveTo(21, 9), ctx.quadraticCurveTo(29, 3, 37, 9)));
});

const M = { w: 34, h: 26 };
const cx = 17;
const cy = 11;
const openShape = (ctx: SKRSContext2D, rx: number, ryTop: number, ryBot: number, teeth: boolean, tongue: boolean) => {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, 1, 0, Math.PI, 0);
  ctx.ellipse(cx, cy, rx, ryBot, 0, 0, Math.PI);
  ctx.closePath();
  ctx.save();
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.clip();
  if (teeth) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(cx - rx, cy - 1, rx * 2, Math.min(4, ryBot / 2));
  }
  if (tongue) {
    ctx.fillStyle = C.tongue;
    ctx.beginPath();
    ctx.ellipse(cx, cy + ryBot, rx * 0.6, ryBot * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  void ryTop;
};
part("mouth_rest", M.w, M.h, (ctx) => stroke(ctx, C.lip, 2.6, () => (ctx.moveTo(8, 11), ctx.quadraticCurveTo(17, 13, 26, 10))));
part("mouth_MBP", M.w, M.h, (ctx) => stroke(ctx, C.lip, 3.6, () => (ctx.moveTo(9, 11), ctx.lineTo(25, 11))));
part("mouth_AI", M.w, M.h, (ctx) => openShape(ctx, 10, 2, 11, true, true));
part("mouth_E", M.w, M.h, (ctx) => openShape(ctx, 12, 1, 6, true, false));
part("mouth_O", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.ellipse(cx, 12, 6.5, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.4;
  ctx.stroke();
});
part("mouth_U", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.ellipse(cx, 12, 4.2, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.6;
  ctx.stroke();
});
part("mouth_FV", M.w, M.h, (ctx) => {
  openShape(ctx, 10, 1, 4, true, false);
  stroke(ctx, C.lip, 2.4, () => (ctx.moveTo(8, 15), ctx.quadraticCurveTo(17, 12, 26, 15)));
});
part("mouth_L", M.w, M.h, (ctx) => openShape(ctx, 9, 1, 8, false, true));
part("mouth_smile", M.w, M.h, (ctx) => stroke(ctx, C.lip, 3, () => (ctx.moveTo(5, 7), ctx.quadraticCurveTo(17, 20, 29, 7))));
part("mouth_smile_AI", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(4, 6);
  ctx.lineTo(30, 6);
  ctx.quadraticCurveTo(28, 25, 17, 24);
  ctx.quadraticCurveTo(6, 25, 4, 6);
  ctx.closePath();
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(6, 7, 22, 4);
  ctx.fillStyle = C.tongue;
  ctx.beginPath();
  ctx.ellipse(17, 20, 7, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
});
part("mouth_smile_E", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.moveTo(4, 7);
  ctx.lineTo(30, 7);
  ctx.quadraticCurveTo(26, 17, 17, 17);
  ctx.quadraticCurveTo(8, 17, 4, 7);
  ctx.closePath();
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(6, 8, 22, 4);
});
part("mouth_sad", M.w, M.h, (ctx) => stroke(ctx, C.lip, 3, () => (ctx.moveTo(7, 15), ctx.quadraticCurveTo(17, 5, 27, 15))));
part("mouth_O_big", M.w, M.h, (ctx) => {
  ctx.beginPath();
  ctx.ellipse(cx, 13, 8, 10, 0, 0, Math.PI * 2);
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.strokeStyle = C.lip;
  ctx.lineWidth = 2.4;
  ctx.stroke();
});

// ---- prop ---------------------------------------------------------------------------------------
png(path.join(HERE, "..", "props"), "mug", 30, 30, (ctx) => {
  rr(ctx, 3, 4, 19, 24, 4, "#f5f1e8");
  ctx.fillStyle = "#e74c3c";
  ctx.fillRect(4, 13, 17, 5);
  stroke(ctx, INK, 2.2, () => ctx.arc(23, 16, 5.5, -Math.PI / 2, Math.PI / 2));
  ctx.fillStyle = "#6f4e37";
  ctx.fillRect(5, 5, 15, 3);
});

// ---- definition ---------------------------------------------------------------------------------
const S = (name: string) => ({ width: sizes[name].w, height: sizes[name].h });
const assets = Object.fromEntries(Object.keys(sizes).filter((n) => n !== "mug").map((n) => [n, `parts/${n}.png`]));

const arm = (side: "r" | "l", z: number, sx: number) => [
  { id: `upper_arm_${side}`, asset: "upper_arm", parent: "torso", x: sx, y: -70, ...S("upper_arm"), anchorX: 0.5, anchorY: 0.12, z },
  { id: `forearm_${side}`, asset: "forearm", parent: `upper_arm_${side}`, x: 0, y: 36, ...S("forearm"), anchorX: 0.5, anchorY: 0.08, z: z + 0.1 },
  { id: `hand_${side}`, asset: "hand", parent: `forearm_${side}`, x: 0, y: 36, anchorX: 0.5, anchorY: 0.3, z: z + 0.2, attachmentPoints: { grip: { x: 0.5, y: 0.5 } } },
];
const leg = (side: "r" | "l", z: number, sx: number) => [
  { id: `thigh_${side}`, asset: "thigh", parent: "hips", x: sx, y: 4, ...S("thigh"), anchorX: 0.5, anchorY: 0.08, z },
  { id: `shin_${side}`, asset: "shin", parent: `thigh_${side}`, x: 0, y: 54, ...S("shin"), anchorX: 0.5, anchorY: 0.06, z: z + 0.1 },
  { id: `foot_${side}`, asset: "foot", parent: `shin_${side}`, x: 2, y: 54, ...S("foot"), anchorX: 0.25, anchorY: 0.3, z: z + 0.2 },
];

const def = {
  id: "pip",
  name: "Pip",
  version: 1,
  kind: "2d",
  description: "Side-view cartoon kid (faces right; mirrored for left). ~300 px tall at scale 1. Prepared test character for the character runtime.",
  assets,
  rig: {
    facing: "right",
    height: 300,
    parts: [
      ...arm("l", 1, -3),
      ...leg("l", 4, -5),
      ...leg("r", 7, 5),
      { id: "hips", asset: "pelvis", x: 0, y: -124, ...S("pelvis"), anchorX: 0.5, anchorY: 0.3, z: 10 },
      { id: "torso", asset: "torso", parent: "hips", x: 0, y: -2, ...S("torso"), anchorX: 0.5, anchorY: 1, z: 12 },
      { id: "head", asset: "head", parent: "torso", x: 4, y: -78, ...S("head"), anchorX: 0.47, anchorY: 0.97, z: 14, attachmentPoints: { top: { x: 0.52, y: 0.05 } } },
      { id: "brows", asset: "brows", parent: "head", x: 24, y: -80, ...S("brows"), z: 15 },
      { id: "eyes", asset: "eyes_open", parent: "head", x: 24, y: -64, ...S("eyes_open"), z: 15 },
      { id: "mouth", asset: "mouth_rest", parent: "head", x: 30, y: -34, ...S("mouth_rest"), z: 15 },
      ...arm("r", 16, 4),
    ],
  },
  sockets: {
    rightHand: { part: "hand_r", point: "grip" },
    leftHand: { part: "hand_l", point: "grip" },
    head: { part: "head", point: "top" },
  },
  motions: {
    idle: {
      duration: 2.4,
      tracks: {
        "torso.rotation": [[0, 0], [1.2, 1.5]],
        "head.rotation": [[0, 0], [1.2, -2.5]],
        "upper_arm_r.rotation": [[0, 2], [1.2, -2]],
        "upper_arm_l.rotation": [[0, -2], [1.2, 2]],
        "hips.y": [[0, 0], [1.2, 1.2]],
      },
    },
    walk: {
      duration: 0.8,
      tracks: {
        "thigh_r.rotation": [[0, -24], [0.4, 24]],
        "thigh_l.rotation": [[0, 24], [0.4, -24]],
        "shin_r.rotation": [[0, 0], [0.4, 6], [0.55, 42], [0.72, 8]],
        "shin_l.rotation": [[0, 6], [0.15, 42], [0.32, 8], [0.4, 0]],
        "foot_r.rotation": [[0, -8], [0.4, 10]],
        "foot_l.rotation": [[0, 10], [0.4, -8]],
        "upper_arm_r.rotation": [[0, 22], [0.4, -22]],
        "upper_arm_l.rotation": [[0, -22], [0.4, 22]],
        "forearm_r.rotation": [[0, -8], [0.4, -30]],
        "forearm_l.rotation": [[0, -30], [0.4, -8]],
        "hips.y": [[0, 0], [0.2, -5], [0.4, 0], [0.6, -5]],
        "torso.rotation": [[0, 3]],
      },
    },
    run: {
      duration: 0.5,
      tracks: {
        "thigh_r.rotation": [[0, -42], [0.25, 34]],
        "thigh_l.rotation": [[0, 34], [0.25, -42]],
        "shin_r.rotation": [[0, 10], [0.25, 20], [0.36, 80], [0.46, 20]],
        "shin_l.rotation": [[0, 20], [0.11, 80], [0.21, 20], [0.25, 10]],
        "upper_arm_r.rotation": [[0, 40], [0.25, -40]],
        "upper_arm_l.rotation": [[0, -40], [0.25, 40]],
        "forearm_r.rotation": [[0, -75]],
        "forearm_l.rotation": [[0, -75]],
        "hips.y": [[0, 0], [0.125, -11], [0.25, 0], [0.375, -11]],
        "torso.rotation": [[0, 11]],
        "head.rotation": [[0, -5]],
      },
    },
    wave: {
      duration: 0.6,
      blend: 0.25,
      tracks: { "upper_arm_r.rotation": [[0, -118]], "forearm_r.rotation": [[0, -62], [0.3, -18]] },
      assets: { hand_r: "hand_open" },
    },
    point: {
      duration: 0.35,
      loop: false,
      blend: 0.15,
      tracks: { "upper_arm_r.rotation": [[0, -20], [0.35, -86]], "forearm_r.rotation": [[0, -10], [0.35, -4]], "hand_r.rotation": [[0, 0]] },
      assets: { hand_r: "hand_point" },
    },
    look_up: { duration: 0.3, loop: false, tracks: { "head.rotation": [[0, -13]] } },
    look_down: { duration: 0.3, loop: false, tracks: { "head.rotation": [[0, 11]] } },
  },
  expressions: {
    smile: { parts: { brows: { asset: "brows_happy", y: -1 } }, mouthSet: "smile" },
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
    walk: { kind: "locomotion", motion: "walk", speed: 200, description: "Walk cycle with arm swing; moves the character." },
    run: { kind: "locomotion", motion: "run", speed: 430, description: "Run cycle, leaning forward." },
    wave: { kind: "gesture", motion: "wave", description: "Raises the right (near) arm and waves; walks/talks can continue." },
    point: { kind: "gesture", motion: "point", description: "Points forward (facing direction) with the right arm and holds." },
    look: { kind: "look", motions: { up: "look_up", down: "look_down" }, description: "Tilts the head up/down (forward = back to normal)." },
  },
  defaults: { blend: 0.2, turnTime: 0.2, blinkDuration: 0.15, autoBlinkInterval: 3.2, facing: "right" },
};
fs.writeFileSync(path.join(OUT, "character.json"), JSON.stringify(def, null, 2) + "\n");
console.log(`pip: ${Object.keys(assets).length} parts, ${def.rig.parts.length} rig parts -> ${path.relative(process.cwd(), OUT)}`);
