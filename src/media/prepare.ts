import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EngineError } from "../errors.js";
import type { Asset, VideoMetadata } from "../scene/schema.js";
import { ffmpegBuild, hashFile, probeMedia, runFFmpeg } from "./process.js";
export const PrepareVideoOptionsSchema = z
  .object({
    threads: z.number().int().min(1).max(256).optional(),
    fps: z.number().positive().max(240).optional(),
    width: z.number().int().positive().max(8192).optional(),
    height: z.number().int().positive().max(8192).optional(),
    fit: z.enum(["contain", "cover"]).optional(),
    gop: z.number().int().min(1).max(300).optional(),
  })
  .strict();
export type PrepareVideoOptions = z.infer<typeof PrepareVideoOptionsSchema>;
export async function prepareVideoAsset(input: string, outDir: string, options: PrepareVideoOptions = {}, signal?: AbortSignal) {
  const o = PrepareVideoOptionsSchema.parse(options);
  const fps = o.fps ?? 30;
  input = await fs.realpath(input);
  await fs.mkdir(outDir, { recursive: true });
  outDir = await fs.realpath(outDir);
  const out = path.join(outDir, "prepared.mp4");
  if (input === out) throw new EngineError("WOULD_OVERWRITE", "Prepared output must differ from source");
  // Refuse existing outputs, including symlinks. Preparation is non-destructive.
  for (const file of [out, path.join(outDir, "video-metadata.json")]) {
    if (
      await fs.lstat(file).then(
        () => true,
        () => false,
      )
    )
      throw new EngineError("WOULD_OVERWRITE", `Output exists: ${file}`);
  }
  const probe = probeMedia(input);
  const stream = probe.streams.find((s: any) => s.codec_type === "video");
  if (!stream) throw new EngineError("INVALID_ASSET", "Input contains no video stream");
  const width = o.width ?? stream.width,
    height = o.height ?? stream.height;
  if (width % 2 || height % 2) throw new EngineError("INVALID_ARGUMENT", "Prepared yuv420p dimensions must be even");
  const warnings: { code: string; message: string }[] = [];
  const ratio =
    o.fit === "cover" ? Math.max(width / stream.width, height / stream.height) : Math.min(width / stream.width, height / stream.height);
  if (ratio > 1) warnings.push({ code: "VIDEO_UPSCALED", message: `Requested dimensions upscale source ${stream.width}x${stream.height}` });
  const filters = [`fps=${fps}`];
  if (o.width || o.height)
    filters.push(
      o.fit === "cover"
        ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
        : `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
    );
  const temp = await fs.mkdtemp(path.join(outDir, ".prepare-"));
  try {
    const prepared = path.join(temp, "prepared.mp4");
    await runFFmpeg(
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        filters.join(","),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(o.gop ?? 15),
        "-keyint_min",
        String(o.gop ?? 15),
        "-sc_threshold",
        "0",
        "-crf",
        "18",
        ...(o.threads === undefined ? [] : ["-threads", String(o.threads)]),
        "-map_metadata",
        "-1",
        "-y",
        prepared,
      ],
      signal,
    );
    const outputProbe = probeMedia(prepared, true);
    const v = outputProbe.streams.find((s: any) => s.codec_type === "video");
    const frameCount = Number(v.nb_read_frames);
    if (!Number.isInteger(frameCount) || frameCount < 1) throw new EngineError("MEDIA_PROBE_FAILED", "Prepared frame count unavailable");
    const video: VideoMetadata = {
      width: v.width,
      height: v.height,
      fps,
      frameCount,
      duration: frameCount / fps,
      preparedBy: "prepare_video_asset@1",
      sha256: hashFile(prepared),
    };
    const metadata = { video, input: probe, output: outputProbe, ffmpeg: ffmpegBuild(), warnings };
    await fs.writeFile(path.join(temp, "video-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
    // link is exclusive and cannot overwrite a concurrently-created destination.
    await fs.link(prepared, out);
    try {
      await fs.link(path.join(temp, "video-metadata.json"), path.join(outDir, "video-metadata.json"));
    } catch (e) {
      await fs.rm(out, { force: true });
      throw e;
    }
    return { ...metadata, file: out, asset: { kind: "video", src: out, video } satisfies Asset };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
