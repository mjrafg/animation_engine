import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { EngineError } from "../errors.js";
import { ffmpegPath } from "../render/video.js";
import { ffmpegBuild } from "../media/process.js";
export const SubtitleOptionsSchema = z
  .object({ file: z.string().min(1), mode: z.enum(["burn", "soft"]), fontsDir: z.string().optional() })
  .strict();
export type SubtitleOptions = z.infer<typeof SubtitleOptionsSchema>;
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
export async function stageSubtitles(input: SubtitleOptions, baseDir: string) {
  const o = SubtitleOptionsSchema.parse(input),
    source = path.resolve(baseDir, o.file),
    ext = path.extname(source).toLowerCase();
  if (!(o.mode === "burn" ? [".ass", ".srt"] : [".srt", ".vtt"]).includes(ext))
    throw new EngineError("INVALID_ARGUMENT", "Unsupported subtitle extension for mode");
  if (!syncFs.existsSync(source)) throw new EngineError("MISSING_SUBTITLE_FILE", "Subtitle file does not exist");
  if (o.mode === "burn" && !o.fontsDir) throw new EngineError("INVALID_ARGUMENT", "Burned subtitles require an explicit fontsDir");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae-subs-"));
  try {
    await fs.copyFile(source, path.join(dir, "captions" + ext));
    if (o.mode === "burn") {
      await fs.mkdir(path.join(dir, "fonts"));
      const fonts = path.resolve(baseDir, o.fontsDir!);
      let count = 0;
      for (const entry of (await fs.readdir(fonts, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (!entry.isFile() || !/\.(ttf|otf|ttc)$/i.test(entry.name)) continue;
        await fs.copyFile(path.join(fonts, entry.name), path.join(dir, "fonts", `${count++}${path.extname(entry.name).toLowerCase()}`));
      }
      if (!count) throw new EngineError("INVALID_ARGUMENT", "fontsDir has no TTF, OTF or TTC files");
      await fs.writeFile(
        path.join(dir, "fonts.conf"),
        `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(path.join(dir, "fonts"))}</dir><cachedir>${escapeXml(path.join(dir, "cache"))}</cachedir></fontconfig>`,
      );
    }
    return {
      dir,
      file: "captions" + ext,
      mode: o.mode,
      env: o.mode === "burn" ? { ...process.env, FONTCONFIG_FILE: path.join(dir, "fonts.conf"), FONTCONFIG_PATH: dir } : process.env,
      cleanup: () => fs.rm(dir, { recursive: true, force: true }),
    };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
}
export type StagedSubtitles = Awaited<ReturnType<typeof stageSubtitles>>;
/** The check actually initializes libass and renders Persian and Korean. HarfBuzz and FriBidi
 * must appear in libass's runtime shaper report; filter availability alone is insufficient. */
export async function mediaCapabilities(fontsDir?: string) {
  let build: string;
  try {
    build = ffmpegBuild();
  } catch (e) {
    return { videoDecode: false, ffmpeg: String(e), subtitles: { burn: false, complexShaping: false, reason: "FFmpeg unavailable" } };
  }
  const decoders = spawnSync(ffmpegPath(), ["-hide_banner", "-decoders"], { encoding: "utf8", timeout: 15000 });
  const videoDecode = decoders.status === 0 && /\bh264\s/.test(decoders.stdout ?? "");
  const filters = spawnSync(ffmpegPath(), ["-hide_banner", "-filters"], { encoding: "utf8", timeout: 15000 });
  const burn = /\bsubtitles\b/.test(filters.stdout ?? "");
  if (!burn || !fontsDir)
    return {
      videoDecode,
      ffmpeg: build,
      subtitles: {
        burn,
        complexShaping: false,
        reason: !burn ? "FFmpeg lacks libass subtitles filter" : "Provide fontsDir to run the Persian/Korean shaping probe",
      },
    };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae-shaping-"));
  let staged: StagedSubtitles | undefined;
  try {
    const file = path.join(dir, "probe.srt");
    await fs.writeFile(file, "1\n00:00:00,000 --> 00:00:01,000\nسلام فارسی\n한국어 자막\n");
    staged = await stageSubtitles({ file, mode: "burn", fontsDir: path.resolve(fontsDir) }, dir);
    const r = spawnSync(
      ffmpegPath(),
      [
        "-v",
        "verbose",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x240:d=0.1",
        "-vf",
        "subtitles=captions.srt:fontsdir=fonts",
        "-frames:v",
        "1",
        "-f",
        "null",
        "-",
      ],
      { cwd: staged.dir, env: staged.env, encoding: "utf8", timeout: 20000 },
    );
    const complexShaping =
      r.status === 0 &&
      /Shaper:.*FriBidi.*HarfBuzz/i.test(r.stderr) &&
      !/failed to find (?:any )?fallback|fontselect:.*failed/i.test(r.stderr);
    return {
      videoDecode,
      ffmpeg: build,
      subtitles: {
        burn: r.status === 0,
        complexShaping,
        reason: complexShaping
          ? undefined
          : r.status !== 0
            ? `Subtitle probe failed: ${r.error?.message ?? r.status}`
            : !/Shaper:.*FriBidi.*HarfBuzz/i.test(r.stderr)
              ? "libass runtime does not report both FriBidi and HarfBuzz"
              : "Explicit fonts lack required Persian or Korean glyphs",
        diagnostics: r.stderr.slice(-12000),
      },
    };
  } catch (e) {
    return {
      videoDecode,
      ffmpeg: build,
      subtitles: { burn, complexShaping: false, reason: `Subtitle probe failed: ${e instanceof Error ? e.message : String(e)}` },
    };
  } finally {
    await staged?.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
