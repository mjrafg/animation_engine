/**
 * "Bruno in the meadow": a 30 s 2D cartoon with Bruno the bear (assets/characters/bruno, drawn
 * after a reference illustration) and his friend Pip. 1920x1080, 24 fps, with music.
 *
 *   npx tsx examples/bruno-meadow/run.ts [--preview]
 *
 * The characters are driven ONLY by high-level actions (walk, wave, talk, smile, look, cheer,
 * shy, ...) and interactions (give_object, hug); the backdrop, speech bubbles and music are
 * generated here, and the bubbles are ordinary layers shown while each line is spoken.
 *
 *   0-4     Bruno waddles into the meadow
 *   4-9     waves: "Hi! I'm Bruno!" ... "What a sunny day!" (looks up at the sky)
 *   9.5-13  Pip comes along; Bruno is surprised, then both wave
 *   14-17   "I brought you some honey!"
 *   17-20   Bruno walks up and hands Pip the honey pot
 *   20-22   "Thank you, Bruno! Yummy!" (Bruno goes shy)
 *   22.6-26 a big hug
 *   26-27.5 Bruno cheers
 *   27.6-30 they walk off together
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import * as ops from "../../src/api/operations.js";
import * as ch from "../../src/characters/operations.js";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager, type VideoWorkspace } from "../../src/workspace/workspace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = path.join(HERE, "out");
const GEN = path.join(OUT, "generated");
const FPS = 24;
const W = 1920;
const H = 1080;
const GROUND = 935;
const F = (s: number) => Math.round(s * FPS);
const preview = process.argv.includes("--preview");

// ---- backdrop -----------------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function paintBackground(file: string) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");
  const rnd = rng(11);
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, 700);
  sky.addColorStop(0, "#8fd0f2");
  sky.addColorStop(0.7, "#cdeaf5");
  sky.addColorStop(1, "#fbf3dc");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // sun with a soft glow
  const glow = ctx.createRadialGradient(1580, 170, 40, 1580, 170, 260);
  glow.addColorStop(0, "rgba(255,244,190,0.9)");
  glow.addColorStop(1, "rgba(255,244,190,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(1300, 0, 560, 460);
  ctx.beginPath();
  ctx.arc(1580, 170, 72, 0, Math.PI * 2);
  ctx.fillStyle = "#ffe27a";
  ctx.fill();
  // clouds
  const cloud = (x: number, y: number, s: number) => {
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    for (const [dx, dy, r] of [
      [0, 0, 42],
      [48, -18, 52],
      [102, 0, 44],
      [52, 14, 44],
      [-36, 12, 30],
      [138, 14, 30],
    ]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  cloud(240, 170, 1.1);
  cloud(820, 110, 0.8);
  cloud(1180, 250, 0.7);
  // distant hills
  const hill = (color: string, base: number, amp: number, phase: number) => {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 10) ctx.lineTo(x, base - amp * (0.6 * Math.sin(x / 300 + phase) + 0.4 * Math.sin(x / 130 + phase * 2)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  hill("#b7dca0", 610, 60, 0.4);
  hill("#9fd08a", 680, 45, 2.1);
  // trees along the hills
  const tree = (x: number, y: number, s: number, dark: string, light: string) => {
    ctx.fillStyle = "#8a5a36";
    ctx.beginPath();
    ctx.roundRect(x - 9 * s, y - 60 * s, 18 * s, 64 * s, 6 * s);
    ctx.fill();
    for (const [dx, dy, r, col] of [
      [0, -110, 58, dark],
      [-42, -80, 42, dark],
      [42, -82, 44, dark],
      [-16, -126, 40, light],
      [22, -104, 36, light],
    ] as [number, number, number, string][]) {
      ctx.beginPath();
      ctx.arc(x + dx * s, y + dy * s, r * s, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
  };
  tree(150, 700, 1.05, "#5aa35a", "#74b86a");
  tree(430, 670, 0.7, "#62ab60", "#7cbf70");
  tree(1370, 690, 0.85, "#5aa35a", "#74b86a");
  tree(1760, 720, 1.2, "#529a52", "#6fb265");
  // meadow
  const meadow = ctx.createLinearGradient(0, 690, 0, H);
  meadow.addColorStop(0, "#8cc76f");
  meadow.addColorStop(1, "#6fb257");
  ctx.fillStyle = meadow;
  ctx.fillRect(0, 700, W, H - 700);
  // path the characters walk on
  ctx.beginPath();
  ctx.moveTo(0, GROUND - 50);
  ctx.bezierCurveTo(600, GROUND - 70, 1300, GROUND - 40, W, GROUND - 60);
  ctx.lineTo(W, GROUND + 60);
  ctx.bezierCurveTo(1300, GROUND + 50, 600, GROUND + 80, 0, GROUND + 55);
  ctx.closePath();
  ctx.fillStyle = "#e7cf9c";
  ctx.fill();
  // grass strokes and flowers
  for (let i = 0; i < 900; i++) {
    const x = rnd() * W;
    const y = 705 + rnd() * (H - 705);
    if (Math.abs(y - GROUND) < 60) continue;
    ctx.strokeStyle = rnd() < 0.5 ? "#5e9f48" : "#7fbd62";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rnd() - 0.5) * 6, y - 8 - rnd() * 8);
    ctx.stroke();
  }
  const colors = ["#ffffff", "#ffd84d", "#ff9fb2", "#b69cff"];
  for (let i = 0; i < 140; i++) {
    const x = rnd() * W;
    const y = 715 + rnd() * (H - 715);
    if (Math.abs(y - GROUND) < 64) continue;
    const r = 4 + rnd() * 4;
    ctx.fillStyle = colors[i % colors.length];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = "#f4b53c";
    ctx.fill();
  }
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

/** Foreground grass tufts drawn in front of the characters' feet at the frame edges. */
function paintForeground(file: string) {
  const c = createCanvas(W, 220);
  const ctx = c.getContext("2d");
  const rnd = rng(5);
  for (const [x0, x1] of [
    [0, 260],
    [1660, W],
  ]) {
    for (let i = 0; i < 90; i++) {
      const x = x0 + rnd() * (x1 - x0);
      const h = 60 + rnd() * 110;
      ctx.fillStyle = rnd() < 0.5 ? "#4f9440" : "#65a94f";
      ctx.beginPath();
      ctx.moveTo(x - 8, 220);
      ctx.quadraticCurveTo(x + (rnd() - 0.5) * 30, 220 - h * 0.6, x + (rnd() - 0.5) * 40, 220 - h);
      ctx.quadraticCurveTo(x + 4, 220 - h * 0.5, x + 8, 220);
      ctx.fill();
    }
  }
  fs.writeFileSync(file, c.toBuffer("image/png"));
}

function paintBubble(file: string, text: string): { w: number; h: number } {
  const probe = createCanvas(10, 10).getContext("2d");
  probe.font = "bold 44px sans-serif";
  const tw = probe.measureText(text).width;
  const w = Math.ceil(tw + 70);
  const h = 130;
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  const body = (fill: string, stroke: string) => {
    ctx.beginPath();
    ctx.roundRect(6, 6, w - 12, 88, 40);
    ctx.moveTo(w / 2 - 22, 92);
    ctx.lineTo(w / 2 - 6, 124);
    ctx.lineTo(w / 2 + 16, 92);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  };
  body("#ffffff", "#6a3a1e");
  ctx.beginPath(); // hide the seam between bubble and tail
  ctx.rect(w / 2 - 19, 86, 32, 10);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.fillStyle = "#4a2a1a";
  ctx.font = "bold 44px sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 35, 52);
  fs.writeFileSync(file, c.toBuffer("image/png"));
  return { w, h };
}

// ---- music: a soft plucked loop (Karplus-Strong), C - G - Am - F --------------------------------------

function music(file: string, seconds: number) {
  const rate = 44100;
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const pluck = (t0: number, freq: number, amp: number, decay = 0.996) => {
    const period = Math.round(rate / freq);
    const buf = new Float32Array(period);
    const r = rng(Math.round(freq * 1000 + t0 * 7));
    for (let i = 0; i < period; i++) buf[i] = r() * 2 - 1;
    const start = Math.round(t0 * rate);
    let idx = 0;
    for (let i = 0; i < rate * 1.6 && start + i < n; i++) {
      const next = (idx + 1) % period;
      const v = decay * 0.5 * (buf[idx] + buf[next]);
      out[start + i] += amp * buf[idx];
      buf[idx] = v;
      idx = next;
    }
  };
  const note = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
  const chords = [
    [60, 64, 67],
    [55, 59, 62],
    [57, 60, 64],
    [53, 57, 60],
  ];
  const melody = [76, 74, 72, 74, 76, 76, 76, 0, 74, 74, 74, 0, 76, 79, 79, 0, 76, 74, 72, 74, 76, 76, 76, 76, 74, 74, 76, 74, 72, 0, 0, 0];
  const beat = 60 / 104;
  for (let b = 0; b * beat < seconds - 1; b++) {
    const t = b * beat;
    const chord = chords[Math.floor(b / 4) % 4];
    pluck(t, note(chord[0] - 12), 0.34);
    pluck(t + beat / 2, note(chord[(b % 2) + 1]), 0.18);
    pluck(t + beat * 0.75, note(chord[2]), 0.12);
    const m = melody[b % melody.length];
    if (m && b >= 8) pluck(t, note(m), 0.16, 0.997);
  }
  // fade in/out, normalise
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 1.0, (seconds - t) / 2.0);
    buf.writeInt16LE(Math.round((out[i] / peak) * 0.6 * env * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

// ---- scene ----------------------------------------------------------------------------------------

function words(text: string, seconds: number) {
  const ws = text.split(" ");
  const step = seconds / ws.length;
  return { text, duration: seconds, words: ws.map((w, i) => ({ word: w, start: +(i * step + 0.03).toFixed(3), end: +((i + 1) * step - 0.06).toFixed(3) })) };
}

const LINES: { id: string; who: string; text: string; start: number; seconds: number }[] = [
  { id: "hi", who: "bruno", text: "Hi! I'm Bruno!", start: 4.4, seconds: 1.7 },
  { id: "sunny", who: "bruno", text: "What a sunny day!", start: 6.6, seconds: 2.0 },
  { id: "pip_hi", who: "pip", text: "Hi, Bruno!", start: 12.7, seconds: 1.3 },
  { id: "honey", who: "bruno", text: "I brought you some honey!", start: 14.6, seconds: 2.2 },
  { id: "thanks", who: "pip", text: "Thank you! Yummy!", start: 20.3, seconds: 1.9 },
  { id: "friends", who: "bruno", text: "Best friends!", start: 26.1, seconds: 1.3 },
];

async function main() {
  fs.rmSync(path.join(OUT, "ws"), { recursive: true, force: true });
  fs.mkdirSync(GEN, { recursive: true });
  const mgr = new WorkspaceManager({ root: path.join(OUT, "ws"), libraries: { characters: path.join(ROOT, "assets", "characters") } });
  const ws = mgr.create("meadow");
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "bruno"));
  await ws.importCharacter(mgr.resolveLibraryDir("characters", "pip"));
  const imp = (file: string, assetId: string) => ws.importAsset({ kind: "file", file, origin: { generated: "examples/bruno-meadow" } }, { assetId });
  paintBackground(path.join(GEN, "meadow.png"));
  paintForeground(path.join(GEN, "grass_front.png"));
  music(path.join(GEN, "music.wav"), 30);
  await imp(path.join(GEN, "meadow.png"), "meadow");
  await imp(path.join(GEN, "grass_front.png"), "grass_front");
  await imp(path.join(GEN, "music.wav"), "music");
  await imp(path.join(ROOT, "assets", "characters", "props", "honey.png"), "honey");
  const bubbleSize: Record<string, { w: number; h: number }> = {};
  for (const l of LINES) {
    bubbleSize[l.id] = paintBubble(path.join(GEN, `bubble_${l.id}.png`), l.text);
    await imp(path.join(GEN, `bubble_${l.id}.png`), `bubble_${l.id}`);
    ws.saveSpeechTiming(l.id, words(l.text, l.seconds));
  }
  const ctx = () => ws.characterContext();

  const s = "bruno_meadow";
  await ws.createScene({ sceneId: s, canvas: { width: W, height: H, fps: FPS, background: "#cdeaf5" }, duration: 30 * FPS });
  await ws.mutateScene(s, (d) =>
    ops.addLayers(d, [
      { id: "meadow", asset: "meadow", x: W / 2, y: H / 2, width: W, height: H, z: 0 },
      { id: "grass_front", asset: "grass_front", x: W / 2, y: H - 110, width: W, height: 220, z: 40 },
    ]),
  );
  // gentle camera push-in (the only hand-made keys besides the bubbles)
  await ws.mutateScene(s, (d) =>
    ops.applyTimelineOps(d, [
      { type: "track.set", target: "camera", property: "scale", keyframes: [{ frame: 0, value: 1, interpolation: "ease-in-out" }, { frame: F(29.9), value: 1.06 }] },
      { type: "track.set", target: "camera", property: "y", keyframes: [{ frame: 0, value: 0, interpolation: "ease-in-out" }, { frame: F(29.9), value: 30 }] },
    ]),
  );

  await ws.mutateScene(s, (d) =>
    ch.addCharacter(d, { id: "bruno", character: "bruno", x: -170, y: GROUND, scale: 1.4, z: 20, props: [{ id: "honey", asset: "honey", socket: "leftHand", scale: 0.4, y: 4, visibleFrom: 14.3 }] }, ctx()),
  );
  await ws.mutateScene(s, (d) => ch.addCharacter(d, { id: "pip", character: "pip", x: 2080, y: GROUND + 4, scale: 1.2, facing: "left", z: 22 }, ctx()));
  const act = (who: string, list: Record<string, unknown>[]) => ws.mutateScene(s, (d) => ch.applyCharacterActions(d, who, list.map((action) => ({ type: "add", action })), ctx()));
  const talk = (id: string) => {
    const l = LINES.find((x) => x.id === id)!;
    return { action: "talk", start: l.start, speech: id };
  };

  await act("bruno", [
    { action: "walk", start: 0, duration: 3.9, to: { x: 760 } },
    { action: "wave", start: 4.1, duration: 2.1 },
    { action: "smile", start: 4.1, duration: 2.3 },
    talk("hi"),
    talk("sunny"),
    { action: "happy", start: 6.6, duration: 2.4 },
    { action: "look", start: 7.4, duration: 1.4, direction: "up" },
    { action: "surprised", start: 9.9, duration: 1.3 },
    { action: "wave", start: 12.9, duration: 1.6 },
    { action: "smile", start: 12.4, duration: 2.1 },
    talk("honey"),
    { action: "smile", start: 14.6, duration: 2.6 },
    { action: "shy", start: 20.3, duration: 2.1 },
    { action: "happy", start: 20.3, duration: 2.1 },
    { action: "cheer", start: 26.0, duration: 1.5 },
    { action: "happy", start: 25.9, duration: 1.7 },
    talk("friends"),
    { action: "walk", start: 27.7, duration: 2.3, to: { x: 2250 } },
  ]);
  await act("pip", [
    { action: "walk", start: 9.4, duration: 3.1, to: { x: 1130 } },
    { action: "wave", start: 12.6, duration: 1.6 },
    { action: "smile", start: 12.6, duration: 1.7 },
    talk("pip_hi"),
    { action: "surprised", start: 15.2, duration: 1.4 },
    talk("thanks"),
    { action: "smile", start: 20.3, duration: 2.4 },
    { action: "smile", start: 25.95, duration: 0.25 },
    { action: "walk", start: 26.2, duration: 3.4, to: { x: 2450 } },
  ]);
  const r = await ws.mutateScene(s, (d) =>
    ch.applyInteractionOps(d, [
      { type: "add", interaction: { id: "gift", interaction: "give_object", actors: ["bruno", "pip"], start: 16.9, duration: 3.3, params: { object: "honey" } } },
      { type: "add", interaction: { id: "hug", interaction: "hug", actors: ["bruno", "pip"], start: 22.5, duration: 3.4 } },
    ], ctx()),
  );
  console.log("warnings:", JSON.stringify(r.warnings.map((w) => w.message)));

  // speech bubbles above the speaker's head while the line is spoken
  const bubbles: Record<string, unknown>[] = [];
  const tops: Record<string, number> = {};
  for (const l of LINES) {
    const lay = await ws.measureLayout(s, F(l.start), [`${l.who}.head`]);
    const head = lay.layers[0].worldBounds;
    const b = bubbleSize[l.id];
    const x = Math.max(b.w / 2 + 20, Math.min(W - b.w / 2 - 20, (head.left + head.right) / 2));
    tops[l.id] = head.top;
    bubbles.push({ id: `bubble_${l.id}`, asset: `bubble_${l.id}`, x, y: head.top - b.h / 2 - 6, width: b.w, height: b.h, z: 50, visible: false });
  }
  await ws.mutateScene(s, (d) => ops.addLayers(d, bubbles));
  await ws.mutateScene(s, (d) =>
    ops.applyTimelineOps(
      d,
      LINES.flatMap((l) => {
        const a = F(l.start - 0.1);
        const b = F(l.start + l.seconds + 0.35);
        return [
          { type: "track.set", target: `bubble_${l.id}`, property: "visible", keyframes: [{ frame: 0, value: false, interpolation: "step" }, { frame: a, value: true, interpolation: "step" }, { frame: b, value: false, interpolation: "step" }] },
          ...["scaleX", "scaleY"].map((property) => ({ type: "track.set", target: `bubble_${l.id}`, property, keyframes: [{ frame: a, value: 0.6, interpolation: "ease-out" }, { frame: a + 5, value: 1 }] })),
        ];
      }),
    ),
  );
  await ws.mutateScene(s, (d) => ops.setAudio(d, [{ src: ws.getAsset("music").file, startFrame: 0, volume: 0.8 }]));

  const tl: any = await ws.inspectInteractions(s);
  for (const ix of tl.interactions) console.log(ix.id, ix.interaction, `${ix.start}-${ix.end}s`, JSON.stringify(ix.injectedActions));

  if (preview) {
    for (const t of [2, 5, 8, 11, 13.3, 15.5, 18.8, 21, 24, 26.8, 29]) {
      const a = await ws.renderFrame(s, F(t));
      fs.copyFileSync(ws.abs(a.relativePath), path.join(OUT, `preview_${t}.png`));
    }
    console.log("previews written");
    return;
  }
  await render(ws, s);
}

async function render(ws: VideoWorkspace, s: string) {
  const jobs = new RenderJobs(ws);
  const t0 = Date.now();
  const j0 = await jobs.start(s, {});
  let j = j0;
  while (!["completed", "failed", "cancelled", "interrupted"].includes(j.status)) j = await jobs.wait(j0.renderId, 30_000);
  if (j.status !== "completed") throw new Error(`render ${j.status}: ${JSON.stringify(j.error)}`);
  fs.copyFileSync(ws.abs(j.artifact!.relativePath), path.join(OUT, "bruno_meadow.mp4"));
  console.log(`done: out/bruno_meadow.mp4 in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
