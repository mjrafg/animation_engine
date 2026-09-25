/** Minimal RGBA image container + sharp-based I/O. Pixel data is straight (non-premultiplied). */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export interface RgbaImage {
  width: number;
  height: number;
  /** width*height*4 bytes, RGBA, row-major. */
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export interface ReadResult {
  image: RgbaImage;
  /** Whether the source file carries an alpha channel. */
  hasAlpha: boolean;
  format: string | undefined;
}

export async function readRgba(input: string | Buffer): Promise<ReadResult> {
  const s = sharp(input);
  const meta = await s.metadata();
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error(`expected 4 channels, got ${info.channels}`);
  return {
    image: { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) },
    hasAlpha: !!meta.hasAlpha,
    format: meta.format,
  };
}

export async function writePng(img: RgbaImage, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(file);
}

/** Writes a single-channel mask (0..255) as a grayscale PNG. */
export async function writeMaskPng(mask: Uint8Array, width: number, height: number, file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.length), { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toFile(file);
}
