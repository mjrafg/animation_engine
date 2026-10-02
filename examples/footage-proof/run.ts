/** Produces the requested deliverable. Scene authoring and composition use EngineSession calls. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { EngineSession } from "../../src/api/tools.js";
import { startEncoder } from "../../src/render/video.js";
import { timingWords } from "../../src/subtitles/timing.js";
const root = path.dirname(new URL(import.meta.url).pathname),
  out = path.join(root, "out");
await fs.mkdir(out, { recursive: true });
const source = path.join(out, "source.mp4");
if (
  !(await fs.stat(source).then(
    () => true,
    () => false,
  ))
) {
  const canvas = createCanvas(2560, 1440),
    c = canvas.getContext("2d");
  const enc = startEncoder({ out: source, width: 2560, height: 1440, fps: 30, frameCount: 780, preset: "ultrafast" });
  try {
    for (let f = 0; f < 780; f++) {
      const t = f < 180 ? f : f < 390 ? 180 : f - 210; // seven-second idle region; barcode alone keeps counting
      c.fillStyle = "#101b31";
      c.fillRect(0, 0, 2560, 1440);
      c.fillStyle = "#233852";
      c.fillRect(80, 150, 520, 1200);
      c.fillRect(650, 150, 1820, 1200);
      c.fillStyle = "#426082";
      for (let row = 0; row < 8; row++) c.fillRect(100, 190 + row * 140, 460, 80);
      c.fillStyle = "#53bed2";
      c.fillRect(720, 240, 500 + t * 1.5, 80);
      c.fillStyle = "#2b83dd";
      c.fillRect(1650, 430, 550, 160);
      c.fillStyle = "#e9effa";
      c.font = "54px sans-serif";
      c.fillText("SYNTHETIC COMPOSITION SOURCE", 720, 780);
      c.font = "38px sans-serif";
      c.fillText("Explicit frames. Explicit motion.", 720, 870);
      for (let bit = 0; bit < 12; bit++) {
        c.fillStyle = (f >> bit) & 1 ? "#ffffff" : "#000000";
        c.fillRect(20 + bit * 60, 20, 56, 80);
      }
      await enc.write(Buffer.from(c.getImageData(0, 0, 2560, 1440).data));
    }
    await enc.finish();
  } catch (e) {
    await enc.abort();
    throw e;
  }
}
const slide = createCanvas(1920, 1080),
  sc = slide.getContext("2d");
sc.fillStyle = "#132840";
sc.fillRect(0, 0, 1920, 1080);
sc.fillStyle = "#6bdac5";
sc.fillRect(120, 140, 160, 12);
sc.fillStyle = "#ffffff";
sc.font = "76px sans-serif";
sc.fillText("Composed from explicit data", 120, 430);
sc.font = "42px sans-serif";
sc.fillText("Footage · vectors · audio · subtitles", 120, 530);
await fs.writeFile(path.join(out, "slide.png"), await slide.encode("png"));
const session = new EngineSession();
const calls: { name: string; args: unknown }[] = [];
async function call(name: string, args: any = {}): Promise<any> {
  calls.push({ name, args });
  const r = await session.call(name, args);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.result;
}
await call("create_scene", {
  baseDir: root,
  name: "Footage composition proof",
  canvas: { width: 1920, height: 1080, fps: 30 },
  duration: 606,
});
let asset: any;
try {
  const meta = JSON.parse(await fs.readFile(path.join(out, "prepared/video-metadata.json"), "utf8"));
  asset = { kind: "video", src: "out/prepared/prepared.mp4", video: meta.video };
} catch {
  asset = (await call("prepare_video_asset", { input: "out/source.mp4", outDir: "out/prepared" })).asset;
  asset.src = "out/prepared/prepared.mp4";
}
await call("set_asset", { id: "footage", asset });
await call("set_asset", { id: "slide", asset: { src: "out/slide.png" } });
for (const layer of [
  { id: "video", asset: "footage", x: 960, y: 540, width: 1920, height: 1080, sourceTime: 0 },
  {
    id: "hole",
    x: 1440,
    y: 380,
    width: 450,
    height: 180,
    visible: false,
    shape: { type: "rect", cornerRadius: 24, fill: "#fff", feather: 10 },
  },
  {
    id: "dim",
    x: 960,
    y: 540,
    width: 1920,
    height: 1080,
    fill: "#000",
    opacity: 0,
    space: "screen",
    z: 30,
    mask: { type: "layer", layer: "hole", invert: true },
  },
  {
    id: "highlight",
    x: 1440,
    y: 380,
    width: 420,
    height: 155,
    shape: { type: "rect", cornerRadius: 18, fill: null, stroke: "#58d9e8", strokeWidth: 4, strokeAlign: "outside" },
    opacity: 0,
    z: 40,
  },
  {
    id: "cursor",
    x: 800,
    y: 650,
    width: 42,
    height: 58,
    anchorX: 0,
    anchorY: 0,
    space: "screen",
    shape: { type: "path", d: "M0 0 L0 45 L12 34 L23 56 L32 51 L21 30 L39 30 Z", fill: "#fff", stroke: "#132438", strokeWidth: 2 },
    z: 60,
  },
  {
    id: "pulse",
    x: 1440,
    y: 400,
    width: 50,
    height: 50,
    space: "screen",
    shape: { type: "ellipse", fill: null, stroke: "#68f0d8", strokeWidth: 4 },
    opacity: 0,
    z: 55,
  },
  { id: "still", asset: "slide", x: 960, y: 540, width: 1920, height: 1080, space: "screen", opacity: 0, z: 70 },
])
  await call("add_layer", { layer });
async function track(target: string, property: string, points: [number, number][], interpolation = "linear") {
  await call("set_track", { target, property, keyframes: points.map(([frame, value]) => ({ frame, value, interpolation })) });
}
await track("video", "sourceTime", [
  [0, 0],
  [180, 6],
  [216, 13],
  [605, 25.9666666667],
]);
await track(
  "camera",
  "scale",
  [
    [0, 1],
    [80, 1],
    [140, 1.5],
    [280, 1.5],
    [350, 1],
    [605, 1],
  ],
  "ease-in-out",
);
await track(
  "camera",
  "x",
  [
    [0, 0],
    [80, 0],
    [140, 320],
    [280, 320],
    [350, 0],
  ],
  "ease-in-out",
);
await track(
  "camera",
  "y",
  [
    [0, 0],
    [80, 0],
    [140, -100],
    [280, -100],
    [350, 0],
  ],
  "ease-in-out",
);
await track(
  "cursor",
  "x",
  [
    [0, 800],
    [120, 1440],
    [300, 1440],
    [390, 1050],
  ],
  "ease-in-out",
);
await track(
  "cursor",
  "y",
  [
    [0, 650],
    [120, 400],
    [300, 400],
    [390, 650],
  ],
  "ease-in-out",
);
await track("hole", "x", [
  [0, 1350],
  [150, 1440],
  [320, 1490],
]);
await track("hole", "width", [
  [0, 400],
  [150, 480],
  [320, 400],
]);
await track("highlight", "opacity", [
  [0, 0],
  [100, 0],
  [125, 1],
  [285, 1],
  [320, 0],
]);
await track("highlight", "cornerRadius", [
  [0, 8],
  [200, 28],
  [320, 8],
]);
await track("highlight", "strokeWidth", [
  [0, 3],
  [200, 6],
  [320, 3],
]);
await track("dim", "opacity", [
  [0, 0],
  [130, 0],
  [155, 0.55],
  [280, 0.55],
  [310, 0],
]);
await track("still", "opacity", [
  [0, 0],
  [370, 0],
  [400, 1],
  [460, 1],
  [490, 0],
]);
const capabilities = await call("capabilities", { fontsDir: "fonts" });
const results: Record<string, unknown> = {};
for (const lang of ["fa", "ko"]) {
  const timing = JSON.parse(await fs.readFile(path.join(root, "fixtures", `${lang}.timing.json`), "utf8"));
  const words = timingWords(timing),
    sentence = words.find((w) => /[.?!؟]$/.test(w.word));
  if (!sentence) throw new Error("Narration fixture requires a sentence boundary");
  const split = sentence.end,
    secondStart = Math.ceil((split + 0.35) * 30);
  const blocks = [
    { timing, startFrame: 0, sourceIn: 0, sourceOut: split },
    { timing, startFrame: secondStart, sourceIn: split, sourceOut: timing.duration },
  ];
  await call("add_audio", {
    track: { src: `fixtures/${lang}.mp3`, startFrame: 0, sourceIn: 0, sourceOut: split, fadeInMs: 10, fadeOutMs: 30 },
  });
  await call("add_audio", {
    track: {
      src: `fixtures/${lang}.mp3`,
      startFrame: secondStart,
      sourceIn: split,
      sourceOut: timing.duration,
      startOffsetMs: 12,
      fadeInMs: 10,
      fadeOutMs: 30,
    },
  });
  blocks[1] = { ...blocks[1], startOffsetMs: 12 } as any;
  const clickWord = words.find((w) => /کلیک|클릭/.test(w.word)) ?? words[Math.floor(words.length / 2)];
  const click = Math.round((clickWord.start < split ? clickWord.start : secondStart / 30 + 0.012 + clickWord.start - split) * 30);
  await track("pulse", "opacity", [
    [0, 0],
    [click - 1, 0],
    [click, 1],
    [click + 24, 0],
  ]);
  for (const prop of ["scaleX", "scaleY"])
    await track("pulse", prop, [
      [0, 0.4],
      [click, 0.4],
      [click + 24, 2.5],
    ]);
  const subtitles = await call("subtitles_from_timing", {
    blocks,
    options: { fps: 30, maxCharacters: lang === "ko" ? 28 : 42, style: { font: lang === "fa" ? "Noto Sans Arabic" : "Noto Sans KR" } },
    outDir: `out/${lang}`,
  });
  await call("save_scene", { path: path.join(root, `${lang}.scene.json`) });
  results[lang] = await call("render_video", {
    out: `out/${lang}.mp4`,
    subtitles: { file: subtitles.ass, mode: "burn", fontsDir: "fonts" },
  });
  await call("remove_audio", { index: 1 });
  await call("remove_audio", { index: 0 });
}
await fs.writeFile(path.join(out, "tool-calls.json"), JSON.stringify(calls, null, 2));
await fs.writeFile(
  path.join(out, "results.json"),
  JSON.stringify(
    {
      machine: { platform: process.platform, arch: process.arch, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, node: process.version },
      capabilities,
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results, null, 2));
