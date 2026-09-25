/**
 * Synthetic ORIGINAL assets for the playground scene (two kids on a seesaw).
 *  - keyed props on solid key colours (Path B): seesaw plank, fulcrum, swing frame, slide, ball
 *  - native transparent parts (Path A): two side-view kids, mouths, swings, handles, clouds,
 *    bird (2 flap frames), flowers
 *  - opaque plate: sky / hills / grass
 * Character parts and props are drawn at 2x (res 2). Pivots / attachment points are recorded in
 * original pixels in manifest.json. Deterministic (seeded noise).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "assets", "originals");
type Pt = { x: number; y: number };
const manifest: Record<string, unknown> = {};

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addNoise(ctx: SKRSContext2D, w: number, h: number, amp: number, seed: number) {
  const rnd = prng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() * 2 - 1) * amp;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

const RES = 2;
const OUTLINE = "#3b2a22";

/**
 * Draws an asset at 2x. `draw` works in 1x units inside a box of w×h placed at the margin.
 * pivot/points are given in 1x box units and stored as 2x original pixels.
 */
async function asset(
  name: string,
  w: number,
  h: number,
  draw: (ctx: SKRSContext2D) => void,
  opts: { pivot?: Pt; points?: Record<string, Pt>; key?: string; margin?: number } = {},
) {
  const m = opts.margin ?? (opts.key ? 30 : 12);
  const c: Canvas = createCanvas((w + 2 * m) * RES, (h + 2 * m) * RES);
  const ctx = c.getContext("2d");
  if (opts.key) {
    ctx.fillStyle = opts.key;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.save();
  ctx.scale(RES, RES);
  ctx.translate(m, m);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  draw(ctx);
  ctx.restore();
  if (opts.key) addNoise(ctx, c.width, c.height, 3, name.length * 17);
  const px = (p: Pt) => ({ x: (p.x + m) * RES, y: (p.y + m) * RES });
  await fs.writeFile(path.join(OUT, `${name}.png`), await c.encode("png"));
  manifest[name] = {
    file: `${name}.png`,
    kind: opts.key ? "keyed" : "transparent",
    ...(opts.key ? { keyColor: opts.key } : {}),
    res: RES,
    ...(opts.pivot ? { pivotPx: px(opts.pivot) } : {}),
    ...(opts.points ? { attachmentPointsPx: Object.fromEntries(Object.entries(opts.points).map(([k, p]) => [k, px(p)])) } : {}),
  };
}

function rr(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string, stroke = OUTLINE, lw = 2.5) {
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

function circle(ctx: SKRSContext2D, x: number, y: number, r: number, fill: string, stroke: string | null = OUTLINE, lw = 2.5) {
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

// ------------------------------------------------------------------------------ background
async function plate() {
  const W = 2100;
  const H = 1180;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, 650);
  sky.addColorStop(0, "#6cb8f0");
  sky.addColorStop(1, "#cdeafa");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // sun
  ctx.fillStyle = "rgba(255,236,150,0.35)";
  ctx.beginPath();
  ctx.arc(1780, 150, 110, 0, Math.PI * 2);
  ctx.fill();
  circle(ctx, 1780, 150, 70, "#ffd95a", null);
  // far hills
  ctx.fillStyle = "#9fd48a";
  ctx.beginPath();
  ctx.moveTo(0, 600);
  ctx.quadraticCurveTo(300, 470, 650, 560);
  ctx.quadraticCurveTo(1000, 640, 1350, 520);
  ctx.quadraticCurveTo(1700, 430, 2100, 560);
  ctx.lineTo(2100, 700);
  ctx.lineTo(0, 700);
  ctx.fill();
  // trees
  const rnd = prng(3);
  for (const [x, s] of [[120, 1.1], [260, 0.8], [1180, 0.9], [1330, 1.2], [1960, 1.0], [2060, 0.8]] as [number, number][]) {
    ctx.fillStyle = "#7a5334";
    ctx.fillRect(x - 12 * s, 560 - 40 * s, 24 * s, 130 * s);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 ? "#4f9e4a" : "#5fb354";
      ctx.beginPath();
      ctx.arc(x + (rnd() - 0.5) * 90 * s, 470 * 1 - 60 * s + (rnd() - 0.5) * 70 * s, (55 + rnd() * 25) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // grass
  const g = ctx.createLinearGradient(0, 640, 0, H);
  g.addColorStop(0, "#7cc862");
  g.addColorStop(1, "#5aa845");
  ctx.fillStyle = g;
  ctx.fillRect(0, 640, W, H - 640);
  // fence
  ctx.strokeStyle = "#f3e7d0";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(0, 620);
  ctx.lineTo(W, 620);
  ctx.moveTo(0, 650);
  ctx.lineTo(W, 650);
  ctx.stroke();
  ctx.fillStyle = "#fbf3e2";
  for (let x = 10; x < W; x += 55) {
    ctx.beginPath();
    ctx.moveTo(x, 675);
    ctx.lineTo(x, 600);
    ctx.lineTo(x + 9, 590);
    ctx.lineTo(x + 18, 600);
    ctx.lineTo(x + 18, 675);
    ctx.fill();
  }
  // sand play area
  ctx.fillStyle = "#ecd9a6";
  ctx.beginPath();
  ctx.ellipse(1050, 1000, 760, 150, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e3cc92";
  ctx.beginPath();
  ctx.ellipse(1050, 1010, 640, 110, 0, 0, Math.PI * 2);
  ctx.fill();
  // grass tufts
  ctx.strokeStyle = "#4a9a3c";
  ctx.lineWidth = 4;
  for (let i = 0; i < 90; i++) {
    const x = rnd() * W;
    const y = 700 + rnd() * 460;
    if (Math.abs(x - 1050) < 700 && Math.abs(y - 1000) < 140) continue;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 6, y - 16);
    ctx.moveTo(x, y);
    ctx.lineTo(x + 5, y - 18);
    ctx.stroke();
  }
  await fs.writeFile(path.join(OUT, "park_bg.png"), await c.encode("png"));
  manifest.park_bg = { file: "park_bg.png", kind: "opaque", res: 1 };
}

// ------------------------------------------------------------------------------ props
async function props() {
  // seesaw plank 760 x 40 (1x). pivot centre; seats on top surface at ±330; handles at ±255
  await asset(
    "plank",
    760,
    40,
    (ctx) => {
      rr(ctx, 0, 12, 760, 20, 8, "#f2b233");
      ctx.fillStyle = "#d99a22";
      ctx.fillRect(4, 26, 752, 4);
      rr(ctx, 10, 2, 90, 14, 6, "#e0453a"); // left seat pad
      rr(ctx, 660, 2, 90, 14, 6, "#e0453a"); // right seat pad
      circle(ctx, 380, 22, 7, "#8a8a8a");
    },
    { key: "#e020c8", pivot: { x: 380, y: 22 }, points: { seat_left: { x: 55, y: 2 }, seat_right: { x: 705, y: 2 }, handle_left: { x: 135, y: 12 }, handle_right: { x: 625, y: 12 } } },
  );
  await asset(
    "fulcrum",
    170,
    130,
    (ctx) => {
      ctx.beginPath();
      ctx.moveTo(85, 6);
      ctx.lineTo(160, 124);
      ctx.lineTo(10, 124);
      ctx.closePath();
      ctx.fillStyle = "#3f7fcf";
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
      ctx.stroke();
      rr(ctx, 0, 118, 170, 12, 5, "#2f5f9f");
      circle(ctx, 85, 14, 10, "#cfcfcf");
    },
    { key: "#e020c8", pivot: { x: 85, y: 130 }, points: { axle: { x: 85, y: 14 } } },
  );
  await asset(
    "handle",
    26,
    64,
    (ctx) => {
      rr(ctx, 9, 8, 8, 56, 3, "#b8b8c0", "#5a5a64", 2);
      rr(ctx, 0, 0, 26, 12, 6, "#e0453a", OUTLINE, 2);
    },
    { pivot: { x: 13, y: 62 }, points: { grip: { x: 13, y: 6 } } },
  );
  // swing frame 560 x 380: A-frame legs, top bar at y 12
  await asset(
    "swing_frame",
    560,
    380,
    (ctx) => {
      ctx.strokeStyle = "#d0463b";
      ctx.lineWidth = 14;
      for (const x of [40, 520]) {
        ctx.beginPath();
        ctx.moveTo(x - 40, 376);
        ctx.lineTo(x, 14);
        ctx.lineTo(x + 40, 376);
        ctx.stroke();
      }
      rr(ctx, 20, 4, 520, 18, 8, "#f0c33c");
    },
    { key: "#1a8fe3", pivot: { x: 280, y: 380 }, points: { swing_1: { x: 190, y: 20 }, swing_2: { x: 370, y: 20 } } },
  );
  await asset(
    "swing",
    80,
    250,
    (ctx) => {
      ctx.strokeStyle = "#6a6a74";
      ctx.lineWidth = 3;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(12, 2);
      ctx.lineTo(8, 236);
      ctx.moveTo(68, 2);
      ctx.lineTo(72, 236);
      ctx.stroke();
      ctx.setLineDash([]);
      rr(ctx, 0, 232, 80, 14, 5, "#3f9f5f");
    },
    { pivot: { x: 40, y: 2 } },
  );
  await asset(
    "slide",
    440,
    330,
    (ctx) => {
      // ladder
      ctx.strokeStyle = "#8a8a94";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(40, 326);
      ctx.lineTo(90, 60);
      ctx.moveTo(80, 326);
      ctx.lineTo(130, 60);
      ctx.stroke();
      ctx.lineWidth = 5;
      for (let i = 1; i < 7; i++) {
        const t = i / 7;
        ctx.beginPath();
        ctx.moveTo(40 + 50 * t, 326 - 266 * t);
        ctx.lineTo(80 + 50 * t, 326 - 266 * t);
        ctx.stroke();
      }
      rr(ctx, 80, 50, 70, 20, 6, "#f0c33c");
      // slide chute
      ctx.beginPath();
      ctx.moveTo(140, 56);
      ctx.bezierCurveTo(260, 80, 300, 290, 436, 300);
      ctx.lineTo(436, 324);
      ctx.bezierCurveTo(290, 316, 240, 110, 140, 84);
      ctx.closePath();
      ctx.fillStyle = "#e8483b";
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 3;
      ctx.stroke();
    },
    { key: "#1a8fe3", pivot: { x: 220, y: 330 } },
  );
  await asset(
    "ball",
    70,
    70,
    (ctx) => {
      circle(ctx, 35, 35, 33, "#f4f1ea");
      ctx.save();
      ctx.beginPath();
      ctx.arc(35, 35, 32, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = "#e0453a";
      ctx.fillRect(0, 22, 70, 26);
      ctx.fillStyle = "#3f7fcf";
      ctx.beginPath();
      ctx.arc(35, 35, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(35, 35, 33, 0, Math.PI * 2);
      ctx.stroke();
    },
    { key: "#23c43a", pivot: { x: 35, y: 35 } },
  );
  // clouds, bird, flowers (transparent)
  await asset("cloud_a", 240, 110, (ctx) => {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (const [x, y, r] of [[60, 70, 38], [110, 50, 48], [165, 65, 40], [200, 80, 28], [100, 82, 32]]) circle(ctx, x, y, r, "rgba(255,255,255,0.95)", null);
  });
  await asset("cloud_b", 180, 80, (ctx) => {
    for (const [x, y, r] of [[45, 50, 28], [85, 36, 34], [130, 48, 28]]) circle(ctx, x, y, r, "rgba(255,255,255,0.9)", null);
  });
  const bird = (up: boolean) => (ctx: SKRSContext2D) => {
    ctx.strokeStyle = "#2b2b36";
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (up) {
      ctx.moveTo(4, 26);
      ctx.quadraticCurveTo(18, 4, 30, 22);
      ctx.quadraticCurveTo(42, 4, 56, 26);
    } else {
      ctx.moveTo(4, 12);
      ctx.quadraticCurveTo(18, 30, 30, 20);
      ctx.quadraticCurveTo(42, 30, 56, 12);
    }
    ctx.stroke();
  };
  await asset("bird_up", 60, 32, bird(true), { pivot: { x: 30, y: 20 } });
  await asset("bird_down", 60, 32, bird(false), { pivot: { x: 30, y: 20 } });
  await asset(
    "flowers",
    220,
    120,
    (ctx) => {
      const rnd = prng(9);
      for (let i = 0; i < 7; i++) {
        const x = 15 + i * 30 + rnd() * 10;
        const top = 30 + rnd() * 40;
        ctx.strokeStyle = "#3d8a35";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x, 120);
        ctx.lineTo(x + (rnd() - 0.5) * 12, top);
        ctx.stroke();
        const col = ["#ff6fa0", "#ffd23f", "#ffffff", "#b77cff"][i % 4];
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          circle(ctx, x + Math.cos(a) * 9, top + Math.sin(a) * 9, 7, col, null);
        }
        circle(ctx, x, top, 5, "#f29a2e", null);
      }
      ctx.fillStyle = "#4f9e4a";
      ctx.beginPath();
      ctx.ellipse(110, 118, 110, 16, 0, Math.PI, 0);
      ctx.fill();
    },
    { pivot: { x: 110, y: 120 } },
  );
}

// ------------------------------------------------------------------------------ kids (side view, facing right)
interface Palette {
  skin: string;
  skinShade: string;
  hair: string;
  shirt: string;
  shirtDark: string;
  shorts: string;
  shoe: string;
  girl: boolean;
}

async function kid(prefix: string, p: Palette) {
  // torso 64x96, hips at (32,88)
  await asset(
    `${prefix}_torso`,
    64,
    96,
    (ctx) => {
      rr(ctx, 6, 64, 52, 30, 10, p.shorts);
      ctx.beginPath();
      ctx.moveTo(14, 6);
      ctx.quadraticCurveTo(32, -2, 52, 6);
      ctx.quadraticCurveTo(62, 12, 60, 40);
      ctx.lineTo(58, 74);
      ctx.lineTo(6, 74);
      ctx.lineTo(4, 30);
      ctx.quadraticCurveTo(4, 10, 14, 6);
      ctx.closePath();
      ctx.fillStyle = p.shirt;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = p.shirtDark;
      ctx.fillRect(7, 66, 50, 6);
      if (p.girl) {
        circle(ctx, 40, 34, 7, "#ffffff", null); // flower print
        circle(ctx, 40, 34, 3, "#ffd23f", null);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px DejaVu Sans";
        ctx.fillText("7", 30, 48);
      }
    },
    { pivot: { x: 32, y: 88 }, points: { neck: { x: 36, y: 4 }, shoulder: { x: 36, y: 16 } } },
  );
  // head 120x124, neck base at (54,122)
  await asset(
    `${prefix}_head`,
    120,
    124,
    (ctx) => {
      rr(ctx, 46, 96, 18, 28, 6, p.skinShade, null);
      if (p.girl) {
        // ponytail at the back
        ctx.fillStyle = p.hair;
        ctx.beginPath();
        ctx.ellipse(10, 64, 14, 26, -0.4, 0, Math.PI * 2);
        ctx.fill();
        circle(ctx, 20, 48, 7, "#ff6fa0", null);
      }
      // face
      circle(ctx, 60, 62, 46, p.skin);
      // nose
      ctx.beginPath();
      ctx.arc(104, 66, 7, -1.4, 1.4);
      ctx.fillStyle = p.skin;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // hair cap
      ctx.fillStyle = p.hair;
      ctx.beginPath();
      ctx.moveTo(14, 70);
      ctx.quadraticCurveTo(10, 14, 62, 12);
      ctx.quadraticCurveTo(102, 12, 104, 44);
      ctx.quadraticCurveTo(80, 30, 62, 40);
      ctx.quadraticCurveTo(46, 48, 40, 70);
      ctx.closePath();
      ctx.fill();
      if (!p.girl) {
        ctx.beginPath();
        ctx.moveTo(40, 16);
        ctx.lineTo(50, 2);
        ctx.lineTo(60, 14);
        ctx.lineTo(72, 2);
        ctx.lineTo(80, 16);
        ctx.fill();
      }
      // ear
      circle(ctx, 42, 70, 9, p.skin);
      ctx.strokeStyle = p.skinShade;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(42, 70, 4, -1, 1.5);
      ctx.stroke();
      // eye
      circle(ctx, 82, 56, 8, "#ffffff", OUTLINE, 2);
      circle(ctx, 85, 57, 4.5, "#2b2b36", null);
      circle(ctx, 86.5, 55, 1.5, "#ffffff", null);
      ctx.strokeStyle = p.hair;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(74, 42);
      ctx.quadraticCurveTo(84, 38, 92, 44);
      ctx.stroke();
      // cheek
      ctx.fillStyle = "rgba(240,110,110,0.35)";
      ctx.beginPath();
      ctx.ellipse(78, 78, 10, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    { pivot: { x: 54, y: 122 }, points: { mouth: { x: 90, y: 88 } } },
  );
  // arm 26x96, shoulder at (13,10), hand at (13,84)
  await asset(
    `${prefix}_arm`,
    26,
    96,
    (ctx) => {
      rr(ctx, 4, 4, 18, 78, 9, p.skin);
      rr(ctx, 2, 0, 22, 30, 10, p.shirt);
      circle(ctx, 13, 84, 10, p.skin);
    },
    { pivot: { x: 13, y: 10 }, points: { hand: { x: 13, y: 84 } } },
  );
  // thigh 30x66, hip (15,8), knee (15,58)
  await asset(
    `${prefix}_thigh`,
    30,
    66,
    (ctx) => {
      rr(ctx, 3, 3, 24, 60, 11, p.skin);
      rr(ctx, 1, 0, 28, 30, 10, p.shorts);
    },
    { pivot: { x: 15, y: 8 }, points: { knee: { x: 15, y: 56 } } },
  );
  // shin 52x74 with shoe pointing right, knee (17,6)
  await asset(
    `${prefix}_shin`,
    52,
    74,
    (ctx) => {
      rr(ctx, 6, 0, 22, 60, 10, p.skin);
      rr(ctx, 6, 48, 22, 10, 3, "#ffffff", OUTLINE, 2);
      ctx.beginPath();
      ctx.moveTo(4, 58);
      ctx.lineTo(30, 58);
      ctx.quadraticCurveTo(50, 60, 50, 70);
      ctx.lineTo(50, 73);
      ctx.lineTo(4, 73);
      ctx.closePath();
      ctx.fillStyle = p.shoe;
      ctx.fill();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    },
    { pivot: { x: 17, y: 6 }, points: { sole: { x: 20, y: 73 } } },
  );
}

async function mouths() {
  const L = "#a8352e";
  await asset("mouth_smile", 30, 16, (ctx) => {
    ctx.strokeStyle = L;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(3, 4);
    ctx.quadraticCurveTo(14, 16, 27, 4);
    ctx.stroke();
  }, { pivot: { x: 15, y: 8 } });
  await asset("mouth_laugh", 30, 22, (ctx) => {
    ctx.beginPath();
    ctx.moveTo(2, 3);
    ctx.lineTo(28, 3);
    ctx.quadraticCurveTo(26, 22, 15, 21);
    ctx.quadraticCurveTo(4, 22, 2, 3);
    ctx.closePath();
    ctx.fillStyle = "#6b1f1f";
    ctx.fill();
    ctx.strokeStyle = L;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(4, 4, 22, 4);
    ctx.fillStyle = "#e3706a";
    ctx.beginPath();
    ctx.ellipse(15, 17, 7, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }, { pivot: { x: 15, y: 8 } });
  await asset("mouth_o", 30, 22, (ctx) => {
    ctx.beginPath();
    ctx.ellipse(15, 11, 7, 9, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#6b1f1f";
    ctx.fill();
    ctx.strokeStyle = L;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }, { pivot: { x: 15, y: 11 } });
}

// ------------------------------------------------------------------------------ audio
function wav(file: string, seconds: number, fill: (t: number) => number) {
  const rate = 48000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(fill(i / rate) * 32767))), 44 + i * 2);
  return fs.writeFile(file, buf);
}

async function audio() {
  const dir = path.join(HERE, "assets", "audio");
  await fs.mkdir(dir, { recursive: true });
  // cheerful pentatonic tune, 0.25 s notes, soft "music box" tone
  const scale = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
  const tune = [0, 2, 4, 2, 3, 4, 5, 4, 3, 1, 2, 0, 2, 4, 3, 2, 0, 2, 4, 5, 4, 3, 2, 1, 0, 1, 2, 4, 3, 2, 1, 0, 2, 3, 4, 2, 0, 1, 2, 0];
  await wav(path.join(dir, "music.wav"), 10, (t) => {
    const i = Math.floor(t / 0.25);
    const note = tune[i % tune.length];
    const dt = t - i * 0.25;
    const env = Math.exp(-dt * 7);
    const f = scale[note];
    const bass = [130.81, 146.83, 164.81, 130.81][Math.floor(t / 1) % 4];
    return 0.22 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) + 0.06 * Math.sin(2 * Math.PI * bass * t) * Math.exp(-(t % 1) * 2);
  });
  // giggles: short bursts of "hee" pulses; laugh start times (s) must match build-scene mouth keys
  const giggles: [number, number][] = [
    [74 / 30, 620], [104 / 30, 520], [134 / 30, 640], [164 / 30, 540], [194 / 30, 660], [224 / 30, 530], [252 / 30, 630],
  ];
  await wav(path.join(dir, "giggles.wav"), 10, (t) => {
    let v = 0;
    for (const [s, pitch] of giggles) {
      const u = t - s;
      if (u < 0 || u > 0.55) continue;
      const k = Math.floor(u / 0.11);
      const du = u - k * 0.11;
      if (k > 4 || du > 0.08) continue;
      const env = Math.sin((Math.PI * du) / 0.08);
      const f = pitch * (1 + 0.12 * Math.sin(2 * Math.PI * 9 * u)) * (1 - 0.04 * k);
      for (let h = 1; h <= 4; h++) v += (Math.sin(2 * Math.PI * f * h * u) / (h * h)) * env * 0.35;
    }
    return v;
  });
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await plate();
  await props();
  await kid("kidA", { skin: "#f6cfb0", skinShade: "#e0ad8a", hair: "#7a3b1c", shirt: "#ff7fa8", shirtDark: "#e0608a", shorts: "#3f7fcf", shoe: "#e0453a", girl: true });
  await kid("kidB", { skin: "#c68a62", skinShade: "#a86f4c", hair: "#2a1c14", shirt: "#ffc93c", shirtDark: "#e0a820", shorts: "#3d8a55", shoe: "#3f4f9f", girl: false });
  await mouths();
  await audio();
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${Object.keys(manifest).length} assets`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
