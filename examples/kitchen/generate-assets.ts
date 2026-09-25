/**
 * Generates the ORIGINAL test assets for the kitchen scene programmatically (no image-generation
 * service is available in this environment). They deliberately mimic what an image model returns:
 *
 *  - "keyed" props (counter, cup, plant) are drawn on a SOLID colour background with a clean
 *    margin, plus seeded per-pixel noise like a real generated image. They exercise Path B
 *    (border detection -> flood fill -> despill -> trim).
 *  - Character parts, window frame, cloud and steam are native transparent PNGs with generous,
 *    uneven transparent margins. They exercise Path A (alpha validation -> trim).
 *
 * Tricky cases built in on purpose:
 *  - cup:  a stripe painted in EXACTLY the blue key colour, fully enclosed by the white mug
 *          (must survive), the hole inside the handle (enclosed background: reported as a hole),
 *          and a stray speck (a disconnected component to be found and removed).
 *  - plant: pockets of magenta enclosed between leaves (holes).
 *
 * Everything is deterministic (seeded PRNG). Output: assets/originals/*.png + manifest.json with
 * pivots/attachment points in ORIGINAL pixel coordinates.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "assets", "originals");

/** mulberry32 seeded PRNG */
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

type Pt = { x: number; y: number };
interface ManifestEntry {
  file: string;
  kind: "keyed" | "transparent" | "opaque";
  keyColor?: string;
  /** pivot in original pixels */
  pivotPx?: Pt;
  attachmentPointsPx?: Record<string, Pt>;
  /** rendering resolution factor: scene size = processed size / res */
  res: number;
  notes?: string;
}
const manifest: Record<string, ManifestEntry> = {};

async function save(name: string, canvas: Canvas, entry: Omit<ManifestEntry, "file">) {
  const file = `${name}.png`;
  await fs.writeFile(path.join(OUT, file), await canvas.encode("png"));
  manifest[name] = { file, ...entry };
}

/** Adds seeded noise (±amp per channel) to opaque pixels, like a generated image. */
function addNoise(ctx: SKRSContext2D, w: number, h: number, amp: number, seed: number) {
  const rnd = prng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() * 2 - 1) * amp;
    const m = (rnd() * 2 - 1) * amp * 0.5;
    d[i] = Math.max(0, Math.min(255, d[i] + n + m));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n - m));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// ----------------------------------------------------------------------------------------------
// Palette
const SKIN = "#f1c29e";
const SKIN_SHADE = "#d99f7a";
const HAIR = "#4a2a1a";
const SHIRT = "#2f8f83";
const SHIRT_DARK = "#236e65";
const PANTS = "#2e3b5c";
const SHOE = "#1f1f24";
const OUTLINE = "#3a2418";

// ----------------------------------------------------------------------------------------------
async function kitchenBackground() {
  const W = 2100;
  const H = 1180;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  // wall
  const wall = ctx.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, "#f4e7cf");
  wall.addColorStop(1, "#e8d5b5");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);
  // backsplash tiles (behind counter area)
  const tileTop = 520;
  const tileBottom = 790;
  ctx.fillStyle = "#dfeaea";
  ctx.fillRect(0, tileTop, W, tileBottom - tileTop);
  ctx.strokeStyle = "#b9cccc";
  ctx.lineWidth = 3;
  for (let y = tileTop; y <= tileBottom; y += 45) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  for (let row = 0; row * 45 + tileTop < tileBottom; row++) {
    for (let x = (row % 2) * 45; x < W; x += 90) {
      ctx.beginPath();
      ctx.moveTo(x, tileTop + row * 45);
      ctx.lineTo(x, tileTop + (row + 1) * 45);
      ctx.stroke();
    }
  }
  // upper cabinets (right side)
  for (let i = 0; i < 4; i++) {
    const x = 1240 + i * 200;
    ctx.fillStyle = "#c98f5a";
    roundRect(ctx, x, 70, 185, 330, 10);
    ctx.fill();
    ctx.strokeStyle = "#8f5f37";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.strokeStyle = "#b07a4a";
    ctx.lineWidth = 4;
    roundRect(ctx, x + 22, 95, 141, 280, 8);
    ctx.stroke();
    ctx.fillStyle = "#e7d7b0";
    ctx.beginPath();
    ctx.arc(x + (i % 2 ? 30 : 155), 330, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  // window opening (dark; the sky layer is shown here through a mask)
  ctx.fillStyle = "#3b4a5a";
  ctx.fillRect(560, 150, 520, 330);
  // shelf with jars (left)
  ctx.fillStyle = "#8f5f37";
  ctx.fillRect(120, 330, 300, 18);
  const jarColors = ["#e0b04a", "#c0543c", "#7aa65a"];
  jarColors.forEach((col, i) => {
    ctx.fillStyle = col;
    roundRect(ctx, 145 + i * 95, 250, 60, 80, 12);
    ctx.fill();
    ctx.fillStyle = "#5b3b22";
    ctx.fillRect(150 + i * 95, 240, 50, 16);
  });
  // floor
  ctx.fillStyle = "#b98a5e";
  ctx.fillRect(0, 1010, W, H - 1010);
  ctx.strokeStyle = "#9a6f47";
  ctx.lineWidth = 4;
  for (let x = 0; x < W; x += 160) {
    ctx.beginPath();
    ctx.moveTo(x, 1010);
    ctx.lineTo(x - 60, H);
    ctx.stroke();
  }
  ctx.fillStyle = "#8a5f3a";
  ctx.fillRect(0, 1000, W, 14);
  // hanging lamp
  ctx.strokeStyle = "#444";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(1500, 0);
  ctx.lineTo(1500, 440);
  ctx.stroke();
  await save("kitchen_bg", c, { kind: "opaque", res: 1, notes: "2100x1180 plate, larger than the 1920x1080 canvas to allow camera moves" });
}

async function skyView() {
  const W = 600;
  const H = 400;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#5aa7e6");
  g.addColorStop(1, "#bfe3f7");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffd75a";
  ctx.beginPath();
  ctx.arc(470, 90, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#7cbf6a";
  ctx.beginPath();
  ctx.moveTo(0, 330);
  ctx.quadraticCurveTo(160, 240, 330, 320);
  ctx.quadraticCurveTo(470, 260, 600, 300);
  ctx.lineTo(600, 400);
  ctx.lineTo(0, 400);
  ctx.fill();
  ctx.fillStyle = "#5fa552";
  ctx.beginPath();
  ctx.moveTo(0, 380);
  ctx.quadraticCurveTo(250, 310, 600, 370);
  ctx.lineTo(600, 400);
  ctx.lineTo(0, 400);
  ctx.fill();
  await save("sky_view", c, { kind: "opaque", res: 1 });
}

async function cloud() {
  const c = createCanvas(300, 200);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (const [x, y, r] of [
    [90, 110, 45],
    [140, 85, 55],
    [195, 105, 45],
    [120, 125, 40],
    [170, 125, 40],
  ]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  await save("cloud", c, { kind: "transparent", res: 1 });
}

async function windowFrame() {
  const W = 640;
  const H = 460;
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const ox = 40;
  const oy = 40;
  // outer frame with transparent opening 520x330 (matches the background opening)
  ctx.fillStyle = "#f7f3ea";
  ctx.fillRect(ox, oy, 560, 370);
  ctx.clearRect(ox + 20, oy + 20, 520, 330);
  ctx.fillRect(ox + 20 + 255, oy + 20, 10, 330); // mullion
  ctx.fillRect(ox + 20, oy + 20 + 160, 520, 10); // transom
  ctx.strokeStyle = "#cfc6b3";
  ctx.lineWidth = 4;
  ctx.strokeRect(ox + 2, oy + 2, 556, 366);
  // sill
  ctx.fillStyle = "#e9e1cf";
  ctx.fillRect(ox - 20, oy + 360, 600, 26);
  await save("window_frame", c, {
    kind: "transparent",
    res: 1,
    notes: "frame outer 560x370 at (40,40); opening 520x330 at (60,60)",
    attachmentPointsPx: { opening_top_left: { x: 60, y: 60 }, opening_bottom_right: { x: 580, y: 390 } },
  });
}

async function counter() {
  // Keyed on GREEN. Content ~1240x420, margin >= 40px.
  const W = 1330;
  const H = 520;
  const KEY = "#23c43a";
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = KEY;
  ctx.fillRect(0, 0, W, H);
  const x0 = 45;
  const y0 = 50;
  // cabinet body
  ctx.fillStyle = "#b5773f";
  ctx.fillRect(x0 + 10, y0 + 40, 1220, 380);
  // doors
  for (let i = 0; i < 4; i++) {
    const dx = x0 + 30 + i * 300;
    ctx.fillStyle = "#c98a4e";
    roundRect(ctx, dx, y0 + 70, 280, 320, 10);
    ctx.fill();
    ctx.strokeStyle = "#8a5a2e";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = "#e9dcc0";
    roundRect(ctx, dx + (i % 2 ? 20 : 245), y0 + 200, 14, 60, 6);
    ctx.fill();
  }
  // toe kick shadow
  ctx.fillStyle = "#6e4623";
  ctx.fillRect(x0 + 10, y0 + 400, 1220, 20);
  // marble top slab
  ctx.fillStyle = "#f1efe9";
  roundRect(ctx, x0, y0, 1240, 48, 8);
  ctx.fill();
  ctx.strokeStyle = "#bdb8ad";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = "rgba(150,150,160,0.5)";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo(x0 + 80 + i * 150, y0 + 8);
    ctx.quadraticCurveTo(x0 + 120 + i * 150, y0 + 30, x0 + 60 + i * 150, y0 + 44);
    ctx.stroke();
  }
  addNoise(ctx, W, H, 4, 21);
  await save("counter_keyed", c, {
    kind: "keyed",
    keyColor: KEY,
    res: 1,
    notes: "counter on solid green; top surface at original y=50",
    attachmentPointsPx: { top_left: { x: x0, y: y0 }, top_right: { x: x0 + 1240, y: y0 } },
  });
}

async function cup() {
  // Keyed on BLUE (20,169,231). Drawn at 2x.
  const W = 420;
  const H = 420;
  const KEY = "#14a9e7";
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = KEY;
  ctx.fillRect(0, 0, W, H);
  // handle: thick ring on the right, its inner hole shows the key colour
  ctx.strokeStyle = "#f7f7f2";
  ctx.lineWidth = 30;
  ctx.beginPath();
  ctx.ellipse(290, 205, 55, 70, 0, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.strokeStyle = "#5a5a5a";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(290, 205, 70, 85, 0, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(290, 205, 40, 55, 0, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  // mug body
  ctx.fillStyle = "#f7f7f2";
  roundRect(ctx, 100, 110, 200, 240, 26);
  ctx.fill();
  ctx.strokeStyle = "#5a5a5a";
  ctx.lineWidth = 5;
  ctx.stroke();
  // the key-coloured stripe fully enclosed by the white body (must be preserved!)
  ctx.fillStyle = KEY;
  ctx.fillRect(122, 205, 156, 44);
  // red rim + red heart
  ctx.fillStyle = "#d8412f";
  ctx.fillRect(103, 113, 194, 22);
  ctx.beginPath();
  ctx.moveTo(200, 318);
  ctx.bezierCurveTo(160, 290, 170, 262, 200, 280);
  ctx.bezierCurveTo(230, 262, 240, 290, 200, 318);
  ctx.fill();
  // coffee visible at the top
  ctx.fillStyle = "#5b3a1e";
  ctx.beginPath();
  ctx.ellipse(200, 116, 92, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  // stray speck: a disconnected artifact the component analysis must find
  ctx.fillStyle = "#d8412f";
  ctx.beginPath();
  ctx.arc(60, 370, 7, 0, Math.PI * 2);
  ctx.fill();
  addNoise(ctx, W, H, 4, 31);
  await save("cup_keyed", c, {
    kind: "keyed",
    keyColor: KEY,
    res: 2,
    notes: "enclosed key-coloured stripe at (122..278, 205..249) must survive; handle hole is enclosed background; speck at (60,370)",
    pivotPx: { x: 200, y: 350 },
    attachmentPointsPx: { handle: { x: 330, y: 205 }, rim_center: { x: 200, y: 112 }, base_center: { x: 200, y: 350 } },
  });
}

async function plant() {
  // Keyed on MAGENTA (contrasts with green leaves).
  const W = 700;
  const H = 700;
  const KEY = "#e020c8";
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = KEY;
  ctx.fillRect(0, 0, W, H);
  const leaf = (x: number, y: number, len: number, ang: number, col: string) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.35, -len * 0.28, len, 0);
    ctx.quadraticCurveTo(len * 0.35, len * 0.28, 0, 0);
    ctx.fill();
    ctx.strokeStyle = "rgba(20,70,30,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len * 0.9, 0);
    ctx.stroke();
    ctx.restore();
  };
  const cols = ["#2e8b3e", "#3fa34d", "#23702f", "#4cb35a"];
  const rnd = prng(7);
  for (let i = 0; i < 16; i++) {
    const ang = -Math.PI / 2 + (i / 15 - 0.5) * 2.4 + (rnd() - 0.5) * 0.2;
    leaf(350, 450, 200 + rnd() * 110, ang, cols[i % cols.length]);
  }
  // pot
  ctx.fillStyle = "#c8643b";
  ctx.beginPath();
  ctx.moveTo(240, 440);
  ctx.lineTo(460, 440);
  ctx.lineTo(430, 650);
  ctx.lineTo(270, 650);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#a94f2c";
  roundRect(ctx, 225, 425, 250, 40, 8);
  ctx.fill();
  addNoise(ctx, W, H, 4, 41);
  await save("plant_keyed", c, { kind: "keyed", keyColor: KEY, res: 1, pivotPx: { x: 350, y: 650 } });
}

async function steam() {
  const c = createCanvas(160, 220);
  const ctx = c.getContext("2d");
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineCap = "round";
  ctx.lineWidth = 12;
  for (const dx of [50, 80, 110]) {
    ctx.beginPath();
    ctx.moveTo(dx, 200);
    ctx.bezierCurveTo(dx - 30, 150, dx + 30, 100, dx, 30);
    ctx.stroke();
  }
  await save("steam", c, { kind: "transparent", res: 2, pivotPx: { x: 80, y: 205 } });
}

// ---------------------------- character parts (transparent, 2x) ------------------------------
const RES = 2;

async function part(
  name: string,
  w: number,
  h: number,
  margin: { l: number; t: number; r: number; b: number },
  draw: (ctx: SKRSContext2D, ox: number, oy: number) => void,
  pivot: Pt,
  points?: Record<string, Pt>,
) {
  const c = createCanvas(w + margin.l + margin.r, h + margin.t + margin.b);
  const ctx = c.getContext("2d");
  draw(ctx, margin.l, margin.t);
  const shift = (p: Pt) => ({ x: p.x + margin.l, y: p.y + margin.t });
  await save(name, c, {
    kind: "transparent",
    res: RES,
    pivotPx: shift(pivot),
    attachmentPointsPx: points ? Object.fromEntries(Object.entries(points).map(([k, p]) => [k, shift(p)])) : undefined,
  });
}

async function characterParts() {
  const M = { l: 37, t: 23, r: 61, b: 45 }; // uneven transparent margins -> exercises trimming
  // torso 2x: 220x330 drawn at 2x => 440x660
  await part(
    "torso",
    440,
    660,
    M,
    (ctx, x, y) => {
      ctx.fillStyle = SHIRT;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x + 70, y + 40);
      ctx.quadraticCurveTo(x + 220, y + 0, x + 370, y + 40);
      ctx.quadraticCurveTo(x + 440, y + 70, x + 420, y + 160);
      ctx.lineTo(x + 380, y + 600);
      ctx.lineTo(x + 60, y + 600);
      ctx.lineTo(x + 20, y + 160);
      ctx.quadraticCurveTo(x + 0, y + 70, x + 70, y + 40);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // neckline
      ctx.fillStyle = SKIN;
      ctx.beginPath();
      ctx.moveTo(x + 160, y + 25);
      ctx.quadraticCurveTo(x + 220, y + 120, x + 280, y + 25);
      ctx.closePath();
      ctx.fill();
      // apron
      ctx.fillStyle = "#f4efe4";
      ctx.beginPath();
      ctx.moveTo(x + 130, y + 200);
      ctx.lineTo(x + 310, y + 200);
      ctx.lineTo(x + 340, y + 600);
      ctx.lineTo(x + 100, y + 600);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#cfc4ae";
      ctx.lineWidth = 4;
      ctx.stroke();
      // belt / waist
      ctx.fillStyle = PANTS;
      ctx.fillRect(x + 60, y + 590, 320, 70);
      ctx.fillStyle = SHIRT_DARK;
      ctx.fillRect(x + 60, y + 588, 320, 8);
    },
    { x: 220, y: 625 }, // hips
    {
      neck: { x: 220, y: 30 },
      right_shoulder: { x: 60, y: 90 }, // character's right = screen left
      left_shoulder: { x: 380, y: 90 },
      hips: { x: 220, y: 625 },
    },
  );

  await part(
    "head",
    340,
    420,
    { l: 51, t: 19, r: 29, b: 67 },
    (ctx, x, y) => {
      // neck
      ctx.fillStyle = SKIN;
      roundRect(ctx, x + 138, y + 320, 64, 100, 20);
      ctx.fill();
      // hair back
      ctx.fillStyle = HAIR;
      ctx.beginPath();
      ctx.ellipse(x + 170, y + 170, 165, 170, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x + 10, y + 170, 70, 160);
      ctx.fillRect(x + 260, y + 170, 70, 160);
      // ears
      ctx.fillStyle = SKIN;
      ctx.beginPath();
      ctx.ellipse(x + 30, y + 215, 22, 34, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 310, y + 215, 22, 34, 0, 0, Math.PI * 2);
      ctx.fill();
      // face
      ctx.fillStyle = SKIN;
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.ellipse(x + 170, y + 215, 135, 150, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // fringe
      ctx.fillStyle = HAIR;
      ctx.beginPath();
      ctx.moveTo(x + 35, y + 180);
      ctx.quadraticCurveTo(x + 60, y + 30, x + 170, y + 40);
      ctx.quadraticCurveTo(x + 290, y + 30, x + 305, y + 180);
      ctx.quadraticCurveTo(x + 250, y + 100, x + 170, y + 110);
      ctx.quadraticCurveTo(x + 90, y + 100, x + 35, y + 180);
      ctx.fill();
      // nose + cheeks
      ctx.strokeStyle = SKIN_SHADE;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(x + 170, y + 225);
      ctx.quadraticCurveTo(x + 158, y + 260, x + 176, y + 265);
      ctx.stroke();
      ctx.fillStyle = "rgba(230,120,110,0.35)";
      ctx.beginPath();
      ctx.ellipse(x + 90, y + 265, 26, 16, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 250, y + 265, 26, 16, 0, 0, Math.PI * 2);
      ctx.fill();
    },
    { x: 170, y: 400 }, // neck base
    { head_center: { x: 170, y: 215 }, eyes_center: { x: 170, y: 195 }, mouth_center: { x: 170, y: 305 } },
  );

  const sleeve = (name: string) =>
    part(
      name,
      110,
      400,
      M,
      (ctx, x, y) => {
        ctx.fillStyle = SHIRT;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 6;
        roundRect(ctx, x + 5, y + 5, 100, 390, 48);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = SHIRT_DARK;
        ctx.fillRect(x + 12, y + 300, 86, 14);
      },
      { x: 55, y: 50 }, // shoulder
      { shoulder: { x: 55, y: 50 }, elbow: { x: 55, y: 345 } },
    );
  await sleeve("right_upper_arm");
  await sleeve("left_upper_arm");

  const forearm = (name: string) =>
    part(
      name,
      96,
      360,
      M,
      (ctx, x, y) => {
        ctx.fillStyle = SKIN;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 6;
        roundRect(ctx, x + 5, y + 5, 86, 350, 42);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = SHIRT;
        roundRect(ctx, x + 2, y + 2, 92, 70, 30);
        ctx.fill();
        ctx.stroke();
      },
      { x: 48, y: 40 }, // elbow
      { elbow: { x: 48, y: 40 }, wrist: { x: 48, y: 325 } },
    );
  await forearm("right_forearm");
  await forearm("left_forearm");

  const hand = (name: string, mirror: boolean) =>
    part(
      name,
      130,
      150,
      M,
      (ctx, x, y) => {
        ctx.save();
        if (mirror) {
          ctx.translate(x * 2 + 130, 0);
          ctx.scale(-1, 1);
        }
        ctx.fillStyle = SKIN;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 6;
        // palm
        ctx.beginPath();
        ctx.ellipse(x + 65, y + 80, 50, 60, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // thumb
        ctx.beginPath();
        ctx.ellipse(x + 112, y + 70, 16, 34, -0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // finger lines
        ctx.lineWidth = 4;
        for (const fx of [45, 65, 85]) {
          ctx.beginPath();
          ctx.moveTo(x + fx, y + 110);
          ctx.lineTo(x + fx, y + 135);
          ctx.stroke();
        }
        ctx.restore();
      },
      { x: 65, y: 20 }, // wrist
      { wrist: { x: 65, y: 20 }, grip: { x: 65, y: 95 } },
    );
  await hand("right_hand", false);
  await hand("left_hand", true);

  const leg = (name: string) =>
    part(
      name,
      130,
      820,
      M,
      (ctx, x, y) => {
        ctx.fillStyle = PANTS;
        ctx.strokeStyle = "#1b2238";
        ctx.lineWidth = 6;
        roundRect(ctx, x + 10, y + 5, 110, 740, 40);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = SHOE;
        roundRect(ctx, x + 0, y + 730, 130, 85, 30);
        ctx.fill();
      },
      { x: 65, y: 40 }, // hip joint
      { hip: { x: 65, y: 40 }, foot: { x: 65, y: 800 } },
    );
  await leg("right_leg");
  await leg("left_leg");

  // eyes (one layer holding both eyes), 2x: 240x80
  const eyes = (name: string, closed: boolean) =>
    part(
      name,
      240,
      80,
      { l: 20, t: 20, r: 20, b: 20 },
      (ctx, x, y) => {
        for (const ex of [55, 185]) {
          if (closed) {
            ctx.strokeStyle = OUTLINE;
            ctx.lineWidth = 7;
            ctx.beginPath();
            ctx.arc(x + ex, y + 38, 30, 0.15 * Math.PI, 0.85 * Math.PI);
            ctx.stroke();
          } else {
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = OUTLINE;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.ellipse(x + ex, y + 45, 34, 30, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#3b6ea8";
            ctx.beginPath();
            ctx.arc(x + ex + 4, y + 48, 17, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#111";
            ctx.beginPath();
            ctx.arc(x + ex + 4, y + 48, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#fff";
            ctx.beginPath();
            ctx.arc(x + ex + 9, y + 42, 4, 0, Math.PI * 2);
            ctx.fill();
          }
          // brows
          ctx.strokeStyle = HAIR;
          ctx.lineWidth = 8;
          ctx.beginPath();
          ctx.moveTo(x + ex - 30, y + 4);
          ctx.quadraticCurveTo(x + ex, y - 8, x + ex + 30, y + 4);
          ctx.stroke();
        }
      },
      { x: 120, y: 45 },
    );
  await eyes("eyes_open", false);
  await eyes("eyes_closed", true);

  // mouths, 2x: 120x80 box, pivot at centre
  const mouth = (name: string, draw: (ctx: SKRSContext2D, x: number, y: number) => void) =>
    part(name, 120, 80, { l: 20, t: 20, r: 20, b: 20 }, draw, { x: 60, y: 40 });
  const LIP = "#b5463e";
  await mouth("mouth_rest", (ctx, x, y) => {
    ctx.strokeStyle = LIP;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x + 25, y + 35);
    ctx.quadraticCurveTo(x + 60, y + 58, x + 95, y + 35);
    ctx.stroke();
  });
  await mouth("mouth_MBP", (ctx, x, y) => {
    ctx.fillStyle = LIP;
    roundRect(ctx, x + 22, y + 32, 76, 16, 8);
    ctx.fill();
  });
  const open = (ctx: SKRSContext2D, cx: number, cy: number, rx: number, ry: number, teeth: boolean) => {
    ctx.fillStyle = "#5a1a1a";
    ctx.strokeStyle = LIP;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx - 3, ry - 3, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#e0736b";
    ctx.beginPath();
    ctx.ellipse(cx, cy + ry * 0.75, rx * 0.7, ry * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    if (teeth) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 0.45);
    }
    ctx.restore();
  };
  await mouth("mouth_A", (ctx, x, y) => open(ctx, x + 60, y + 42, 30, 30, true));
  await mouth("mouth_O", (ctx, x, y) => open(ctx, x + 60, y + 40, 20, 24, false));
  await mouth("mouth_E", (ctx, x, y) => open(ctx, x + 60, y + 40, 40, 16, true));
}

async function voice() {
  // Synthetic "speech": syllable blips aligned with the mouth keyframes (frames at 30 fps).
  const rate = 48000;
  const seconds = 11;
  const n = rate * seconds;
  const pcm = new Int16Array(n);
  const fps = 30;
  // [startFrame, endFrame, base pitch] syllables; must match build-scene.ts talk timing
  const syll: [number, number, number][] = [
    [210, 216, 210], [218, 224, 240], [227, 233, 200], [236, 244, 260],
    [252, 258, 220], [260, 268, 250], [271, 277, 205], [280, 290, 230],
  ];
  for (const [f0, f1, pitch] of syll) {
    const s0 = Math.floor((f0 / fps) * rate);
    const s1 = Math.floor((f1 / fps) * rate);
    for (let i = s0; i < s1 && i < n; i++) {
      const t = (i - s0) / rate;
      const u = (i - s0) / (s1 - s0);
      const env = Math.sin(Math.PI * u) ** 0.6;
      const f = pitch * (1 + 0.08 * Math.sin(2 * Math.PI * 5 * t));
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h * 0.6 + 0.4);
      pcm[i] = Math.max(-32767, Math.min(32767, v * env * 9000));
    }
  }
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
  Buffer.from(pcm.buffer).copy(buf, 44);
  await fs.mkdir(path.join(HERE, "assets", "audio"), { recursive: true });
  await fs.writeFile(path.join(HERE, "assets", "audio", "voice.wav"), buf);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  await kitchenBackground();
  await skyView();
  await cloud();
  await windowFrame();
  await counter();
  await cup();
  await plant();
  await steam();
  await characterParts();
  await voice();
  await fs.writeFile(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${Object.keys(manifest).length} assets to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
