/**
 * Asset catalog: resolves scene asset ids to files and caches their bytes + natural sizes.
 * Backend-neutral (renderers decode the bytes into their own image type).
 */
import fs from "node:fs/promises";
import { probeMedia } from "../media/process.js";
import { SceneValidationError } from "../scene/validate.js";
import sharp from "sharp";
import type { Scene, VideoMetadata } from "../scene/schema.js";
import { resolveScenePath } from "../scene/validate.js";

export interface LoadedImageAsset {
  id: string;
  file: string;
  bytes: Buffer;
  kind?: "image";
  video?: undefined;
  width: number;
  height: number;
}

export interface LoadedVideoAsset {
  id: string;
  file: string;
  kind: "video";
  video: VideoMetadata;
  width: number;
  height: number;
}
export type LoadedAsset = LoadedImageAsset | LoadedVideoAsset;

export class AssetCatalog {
  private assets = new Map<string, LoadedAsset>();
  /** Per-file cache so re-validating/re-loading a scene does not re-read unchanged files. */
  private byFile = new Map<string, { mtimeMs: number; asset: Omit<LoadedImageAsset, "id"> }>();

  async load(scene: Scene, baseDir: string | undefined): Promise<void> {
    const next = new Map<string, LoadedAsset>();
    for (const [id, a] of Object.entries(scene.assets)) {
      const file = resolveScenePath(baseDir, a.src);
      if (a.kind === "video" && a.video) {
        const probe = probeMedia(file);
        const v = probe.streams.find((s: any) => s.codec_type === "video");
        const rateMatches = (value: unknown) => {
          const [n, d] = String(value).split("/").map(Number);
          const rate = n / d;
          return Number.isFinite(rate) && Math.abs(rate - a.video!.fps) <= 1e-6;
        };
        if (
          !v ||
          v.width !== a.video.width ||
          v.height !== a.video.height ||
          !rateMatches(v.avg_frame_rate) ||
          !rateMatches(v.r_frame_rate) ||
          Math.abs(a.video.duration - a.video.frameCount / a.video.fps) > 1e-6 ||
          Number(v.nb_frames) !== a.video.frameCount ||
          v.pix_fmt !== "yuv420p" ||
          probe.streams.some((s: any) => s.codec_type === "audio")
        ) {
          throw new SceneValidationError([
            {
              severity: "error",
              code: "VIDEO_NOT_PREPARED",
              path: ["assets", id, "video"],
              message: "Prepared metadata does not match the silent CFR video stream",
            },
          ]);
        }
        next.set(id, { id, file, kind: "video", width: a.video.width, height: a.video.height, video: a.video });
        continue;
      }
      const stat = await fs.stat(file);
      let cached = this.byFile.get(file);
      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const bytes = await fs.readFile(file);
        const meta = await sharp(bytes).metadata();
        if (!meta.width || !meta.height) throw new Error(`Cannot read image size of ${file}`);
        cached = { mtimeMs: stat.mtimeMs, asset: { file, bytes, width: meta.width, height: meta.height } };
        this.byFile.set(file, cached);
      }
      next.set(id, { id, ...cached.asset });
    }
    this.assets = next;
  }

  get(id: string): LoadedAsset | undefined {
    return this.assets.get(id);
  }

  size = (id: string): { width: number; height: number } | undefined => {
    const a = this.assets.get(id);
    return a ? { width: a.width, height: a.height } : undefined;
  };

  all(): LoadedAsset[] {
    return [...this.assets.values()];
  }
}
