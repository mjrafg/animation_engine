/**
 * Produces the evidence images referenced by docs/REPORT.md (docs/img/*). Everything is derived
 * from the current pipeline outputs, the scene JSON and the DECODED final MP4.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { EngineSession } from "../../src/api/tools.js";
import { ffmpegPath } from "../../src/render/video.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const IMG = path.join(ROOT, "docs", "img");
const TMP = path.join(HERE, "out", ".tmp");

async function crop(file: string, l: number, t: number, w: number, h: number, factor = 1, bg?: string) {
  let img = sharp(file).extract({ left: l, top: t, width: w, height: h });
  if (bg) img = img.flatten({ background: bg });
  return sharp(await img.png().toBuffer()).resize({ width: Math.round(w * factor), kernel: factor > 1 ? "nearest" : "lanczos3" }).png().toBuffer();
}

async function row(parts: Buffer[], out: string, gap = 12, bg = "#888888") {
  const metas = await Promise.all(parts.map((p) => sharp(p).metadata()));
  const H = Math.max(...metas.map((m) => m.height!));
  let x = 0;
  const comps = parts.map((input, i) => {
    const c = { input, left: x, top: 0 };
    x += metas[i].width! + gap;
    return c;
  });
  await sharp({ create: { width: x - gap, height: H, channels: 4, background: bg } }).composite(comps).png().toFile(out);
}

function videoFrame(n: number, out: string) {
  const r = spawnSync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-i", path.join(HERE, "out", "kitchen.mp4"), "-vf", `select=eq(n\\,${n})`, "-vsync", "vfr", "-frames:v", "1", "-y", out]);
  if (r.status !== 0) throw new Error(String(r.stderr));
}

async function main() {
  await fs.mkdir(IMG, { recursive: true });
  await fs.mkdir(TMP, { recursive: true });
  const P = path.join(HERE, "assets", "processed");

  // 1. keyed asset edges over a dark background, 4-6x nearest-neighbour zoom
  await row(
    [
      await crop(path.join(P, "counter_keyed", "processed-transparent.png"), 0, 0, 120, 70, 4, "#303030"),
      await crop(path.join(P, "cup_keyed", "processed-transparent.png"), 119, 0, 150, 120, 3, "#303030"),
      await crop(path.join(P, "plant_keyed", "processed-transparent.png"), 0, 100, 150, 120, 3, "#303030"),
    ],
    path.join(IMG, "keyed_edges_zoom.png"),
  );
  // 2. cup pipeline stages: original | background mask | processed (on orange)
  await row(
    [
      await sharp(path.join(P, "cup_keyed", "original.png")).png().toBuffer(),
      await sharp(path.join(P, "cup_keyed", "background-mask.png")).png().toBuffer(),
      await sharp(path.join(P, "cup_keyed", "untrimmed-transparent.png")).flatten({ background: "#f0a040" }).png().toBuffer(),
      await sharp(path.join(P, "cup_keyed", "processed-transparent.png")).flatten({ background: "#f0a040" }).png().toBuffer(),
    ],
    path.join(IMG, "cup_pipeline_stages.png"),
  );

  // 3. hand-off layering: old z values (cup 21 / 32) vs the fixed ones (30.5), frames 154 | 155
  const s = new EngineSession();
  await s.call("load_scene", { path: path.join(HERE, "scene.json") });
  const render = async (tag: string) => {
    const out: Buffer[] = [];
    for (const f of [154, 155]) {
      const file = path.join(TMP, `${tag}_${f}.png`);
      const r = await s.call("render_preview", { frame: f, out: file });
      if (!r.ok) throw new Error(JSON.stringify(r));
      out.push(await crop(file, 820, 470, 330, 250));
    }
    return out;
  };
  const fixed = await render("fixed");
  await s.call("update_layer", { id: "cup_on_counter", patch: { z: 21 } });
  await s.call("update_layer", { id: "cup_in_hand", patch: { z: 32 } });
  const old = await render("old");
  await row([...old, ...fixed], path.join(IMG, "handoff_z_before_after.png"));

  // 4. feedback loop: before | after at the pick-up frame (normal + debug)
  const FL = path.join(HERE, "out", "feedback-loop");
  await row(
    [
      await crop(path.join(FL, "before_155.png"), 700, 330, 560, 420),
      await crop(path.join(FL, "after_155.png"), 700, 330, 560, 420),
    ],
    path.join(IMG, "feedback_loop_before_after.png"),
  );

  // 5. frames decoded from the final MP4 (every 30th frame), 4x3 grid
  const grid = path.join(IMG, "video_frames_grid.png");
  const r = spawnSync(ffmpegPath(), [
    "-hide_banner", "-loglevel", "error", "-i", path.join(HERE, "out", "kitchen.mp4"),
    "-vf", "select='not(mod(n\\,30))',scale=480:270,tile=4x3", "-frames:v", "1", "-vsync", "vfr", "-y", grid,
  ]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  // 6. talk close-up from the decoded video (mouth shapes)
  // The crop window comes from measure_layout (screen-space centre of the mouth layer), so it
  // stays correct under the zoomed camera.
  const talk: Buffer[] = [];
  for (const f of [212, 219, 228, 238, 253]) {
    const file = path.join(TMP, `v${f}.png`);
    videoFrame(f, file);
    const lay = (await s.call("measure_layout", { frame: f, layers: ["mouth"] })) as any;
    const c = lay.result.layers[0].screenCenter;
    talk.push(await crop(file, Math.round(c.x - 120), Math.round(c.y - 110), 240, 180));
  }
  await row(talk, path.join(IMG, "video_mouth_shapes.png"));

  await fs.rm(TMP, { recursive: true, force: true });
  console.log("wrote docs/img/*");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
