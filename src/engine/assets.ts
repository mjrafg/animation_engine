/**
 * Asset catalog: resolves scene asset ids to files and caches their bytes + natural sizes.
 * Backend-neutral (renderers decode the bytes into their own image type).
 */
import fs from "node:fs/promises";
import sharp from "sharp";
import type { Scene } from "../scene/schema.js";
import { resolveScenePath } from "../scene/validate.js";

export interface LoadedAsset {
  id: string;
  file: string;
  bytes: Buffer;
  width: number;
  height: number;
}

export class AssetCatalog {
  private assets = new Map<string, LoadedAsset>();
  /** Per-file cache so re-validating/re-loading a scene does not re-read unchanged files. */
  private byFile = new Map<string, { mtimeMs: number; asset: Omit<LoadedAsset, "id"> }>();

  async load(scene: Scene, baseDir: string | undefined): Promise<void> {
    const next = new Map<string, LoadedAsset>();
    for (const [id, a] of Object.entries(scene.assets)) {
      const file = resolveScenePath(baseDir, a.src);
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
