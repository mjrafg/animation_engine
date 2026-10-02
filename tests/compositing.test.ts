import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AnimationEngine } from '../src/api/engine.js';
import { SceneSchema } from '../src/scene/schema.js';
import { validateScene } from '../src/scene/validate.js';
import { evaluateScene } from '../src/timeline/evaluate.js';
import { prepareVideoAsset, PrepareVideoOptionsSchema } from '../src/media/prepare.js';
import { FFmpegFrameSource } from '../src/media/frames.js';
import { runFFmpeg } from '../src/media/process.js';
import { startEncoder } from '../src/render/video.js';
import { stageSubtitles, mediaCapabilities } from '../src/subtitles/encode.js';
import { subtitlesFromTiming } from '../src/subtitles/timing.js';
import { EngineSession } from '../src/api/tools.js';
import { baseScene, pixel, tmpDir } from './helpers.js';
const dir = tmpDir('compositing-');
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const barcode = (data: Buffer, width = 96) => Array.from({ length: 8 }, (_, bit) => data[(12 * width + bit * 12 + 6) * 4] > 128 ? 2 ** bit : 0).reduce((a, b) => a + b, 0);
async function videoFixture() {
  const input = path.join(dir, 'source.mp4');
  const encoder = startEncoder({ out: input, width: 96, height: 32, fps: 30, frameCount: 80, crf: 0, preset: 'ultrafast' });
  try {
    for (let i = 0; i < 80; i++) {
      const rgba = Buffer.alloc(96 * 32 * 4);
      for (let y = 0; y < 32; y++) for (let x = 0; x < 96; x++) {
        const n = (y * 96 + x) * 4, v = (i >> Math.floor(x / 12)) & 1 ? 255 : 0;
        rgba[n] = rgba[n + 1] = rgba[n + 2] = v; rgba[n + 3] = 255;
      }
      await encoder.write(rgba);
    }
    await encoder.finish();
  } catch (e) { await encoder.abort(); throw e; }
  return prepareVideoAsset(input, path.join(dir, 'prepared'), { fps: 30, threads: 2 });
}
let prepared: ReturnType<typeof videoFixture> | undefined;
const fixture = () => prepared ??= videoFixture();
const expected = (f: number) => f < 8 ? f : f < 14 ? 8 + 6 * (f - 8) : f < 18 ? 44 : f < 23 ? 5 : f < 28 ? 60 + f - 23 : 2;
function videoScene(asset: unknown) {
  return { canvas: { width: 96, height: 32, fps: 30 }, duration: 32, assets: { v: asset }, layers: [{ id: 'v', asset: 'v', x: 48, y: 16 }], animations: [{ target: 'v', property: 'sourceTime', keyframes: [
    { frame: 0, value: 0 }, { frame: 8, value: 8 / 30 }, { frame: 14, value: 44 / 30, interpolation: 'step' },
    { frame: 18, value: 5 / 30, interpolation: 'step' }, { frame: 23, value: 2 }, { frame: 27, value: 64 / 30, interpolation: 'step' }, { frame: 28, value: 2 / 30 },
  ] }] };
}
describe('prepared video frame accuracy', () => {
  it('lets FFmpeg choose preparation threads unless an explicit positive limit is supplied', () => {
    expect(PrepareVideoOptionsSchema.parse({}).threads).toBeUndefined();
    expect(PrepareVideoOptionsSchema.parse({ threads: 2 }).threads).toBe(2);
    for (const threads of [0, -1, 1.5, 257]) expect(PrepareVideoOptionsSchema.safeParse({ threads }).success).toBe(false);
  });
  it('preserves source, validates metadata and rejects changed bytes', async () => {
    const p = await fixture();
    expect(p.video.frameCount).toBe(80);
    expect(validateScene(videoScene(p.asset), { baseDir: dir }).ok).toBe(true);
    const changed = path.join(dir, 'changed.mp4'); await fs.copyFile(p.file, changed); await fs.appendFile(changed, 'changed');
    expect(validateScene(videoScene({ ...p.asset, src: changed }), { baseDir: dir }).errors.map(e => e.code)).toContain('VIDEO_HASH_MISMATCH');
    await expect(prepareVideoAsset(p.file, path.dirname(p.file))).rejects.toMatchObject({ code: 'WOULD_OVERWRITE' });
  }, 120000);
  it.each(['random', 'sequential'] as const)('selects exact barcodes in %s mode across forward/backward jumps and holds', async mode => {
    const p = await fixture(), source = new FFmpegFrameSource(p.file, p.video, { mode, cacheBytes: 96 * 32 * 4 * 2, maxForwardFrames: 8 });
    try { for (let frame = 0; frame < 32; frame++) expect(barcode((await source.getFrame(expected(frame))).data)).toBe(expected(frame)); }
    finally { await source.close(); }
  }, 120000);
  it('draws the timeline in previews and both encode modes with no barcode mismatches', async () => {
    const p = await fixture(), e = new AnimationEngine(videoScene(p.asset), dir); await e.prepare();
    try {
      for (let f = 0; f < 32; f++) {
        expect(e.measureLayout(f).layers[0].sourceFrame).toBe(expected(f));
        expect(barcode((await e.renderFrame(f)).rgba())).toBe(expected(f));
      }
      const hashes: string[][] = [];
      for (const chunks of [1, 2]) {
        const file = path.join(dir, `render-${chunks}.mp4`);
        await e.renderVideo(file, { chunks, crf: 0 });
        const source = new FFmpegFrameSource(file, { ...p.video, frameCount: 32 }, { mode: 'sequential' });
        const pixels: string[] = [];
        try { for (let f = 0; f < 32; f++) { const rgba = (await source.getFrame(f)).data; expect(barcode(rgba)).toBe(expected(f)); pixels.push(hash(rgba)); } }
        finally { await source.close(); }
        hashes.push(pixels);
      }
      expect(hashes[0]).toEqual(hashes[1]);
    } finally { await e.closeVideoSources(); }
  }, 120000);
  it('closes decoders on cancellation and rejects future reads', async () => {
    const p = await fixture(), ctrl = new AbortController(), source = new FFmpegFrameSource(p.file, p.video, { mode: 'sequential', signal: ctrl.signal });
    await source.getFrame(0); ctrl.abort(); await source.close();
    await expect(source.getFrame(1)).rejects.toMatchObject({ code: 'RENDER_CANCELLED' });
    const e = new AnimationEngine(videoScene(p.asset), dir); await e.prepare();
    const file = path.join(dir, 'cancelled.mp4'), cancel = new AbortController();
    await expect(e.renderVideo(file, { signal: cancel.signal, onProgress: () => cancel.abort() })).rejects.toMatchObject({ code: 'RENDER_CANCELLED' });
    await expect(fs.stat(file)).rejects.toBeDefined();
  }, 120000);
});
describe('shapes, masks and screen space', () => {
  const doc = baseScene({ canvas: { width: 100, height: 100, fps: 30, background: '#fff' }, camera: { scale: 2 }, layers: [
    { id: 'hole', x: 50, y: 50, width: 20, height: 20, visible: false, shape: { type: 'rect', cornerRadius: 5, fill: '#fff', feather: 2 } },
    { id: 'dim', x: 50, y: 50, width: 100, height: 100, space: 'screen', fill: '#000', opacity: 0.6, mask: { type: 'layer', layer: 'hole', invert: true } },
    { id: 'outline', space: 'screen', x: 12.25, y: 12.25, width: 12, height: 12, shape: { type: 'rect', stroke: '#f00', strokeWidth: 2, strokeAlign: 'outside' } },
  ], animations: [{ target: 'hole', property: 'x', keyframes: [{ frame: 0, value: 50 }, { frame: 10, value: 65 }] }, { target: 'outline', property: 'cornerRadius', keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 6 }] }] });
  it.each(['inside', 'center', 'outside'] as const)('draws %s strokes at screen resolution under camera zoom', async strokeAlign => {
    const e = new AnimationEngine(baseScene({
      canvas: { width: 64, height: 64, fps: 30, background: '#0000' }, camera: { scale: 2 },
      layers: [{ id: 's', x: 32.125, y: 32, width: 20, height: 20, shape: { type: 'rect', stroke: '#fff', strokeWidth: 4, strokeAlign } }],
      animations: [{ target: 's', property: 'strokeWidth', keyframes: [{ frame: 0, value: 4 }, { frame: 10, value: 1 }] }],
    }), dir);
    await e.prepare();
    const rgba = (await e.renderFrame(0)).rgba();
    const alpha = (x: number) => rgba[(32 * 64 + x) * 4 + 3];
    const left = strokeAlign === 'inside' ? 12 : strokeAlign === 'center' ? 8 : 4;
    expect(alpha(left - 1)).toBe(0);
    expect(alpha(left)).toBeGreaterThan(0); expect(alpha(left)).toBeLessThan(255);
    expect(alpha(left + 2)).toBe(255);
    expect(alpha(32)).toBe(0);
    const thin = (await e.renderFrame(10)).rgba();
    const coverage = (data: Buffer) => Array.from({ length: 64 }, (_, x) => data[(32 * 64 + x) * 4 + 3]).reduce((a, b) => a + b, 0);
    expect(coverage(thin)).toBeLessThan(coverage(rgba));
  });
  it('keeps pixel-aligned outside stroke edges hard without bleeding into the fill', async () => {
    const e = new AnimationEngine(baseScene({
      canvas: { width: 64, height: 64, fps: 30, background: '#0000' }, camera: { scale: 2 },
      layers: [{ id: 's', x: 32, y: 32, width: 20, height: 20,
        shape: { type: 'rect', fill: '#f00', stroke: '#fff', strokeWidth: 4, strokeAlign: 'outside' } }],
    }), dir);
    await e.prepare();
    const frame = { width: 64, data: (await e.renderFrame(0)).rgba() };
    for (let x = 0; x < 64; x++) {
      const inStroke = (x >= 4 && x < 12) || (x >= 52 && x < 60);
      const inFill = x >= 12 && x < 52;
      expect(pixel(frame, x, 32), `pixel ${x}`).toEqual(inStroke ? [255, 255, 255, 255] : inFill ? [255, 0, 0, 255] : [0, 0, 0, 0]);
    }
  });
  it.each(['rect', 'ellipse', 'path'] as const)('preserves fill, opacity and earlier layers behind an outside %s stroke', async type => {
    for (const masked of [false, true]) {
      const e = new AnimationEngine(baseScene({
        canvas: { width: 64, height: 64, fps: 30, background: '#00f' },
        layers: [
          { id: 'mask', x: 32, y: 32, width: 64, height: 64, visible: false, fill: '#fff' },
          { id: 's', x: 32, y: 32, width: 20, height: 20, opacity: 0.5,
            ...(masked ? { mask: { type: 'layer', layer: 'mask' } } : {}),
            shape: { type, ...(type === 'path' ? { d: 'M0 0 H20 V20 H0 Z' } : {}), fill: '#f00', stroke: '#fff', strokeWidth: 4, strokeAlign: 'outside' } },
        ],
      }), dir);
      await e.prepare();
      const frame = { width: 64, data: (await e.renderFrame(0)).rgba() };
      const center = pixel(frame, 32, 32), edge = pixel(frame, 20, 32);
      expect(center[0]).toBeGreaterThanOrEqual(127); expect(center[0]).toBeLessThanOrEqual(128);
      expect(center[1]).toBe(0); expect(center[2]).toBeGreaterThanOrEqual(127); expect(center[3]).toBe(255);
      expect(edge[0]).toBeGreaterThanOrEqual(127); expect(edge[0]).toBeLessThanOrEqual(128);
      expect(edge[1]).toBe(edge[0]); expect(edge[2]).toBe(255); expect(edge[3]).toBe(255);
      expect(pixel(frame, 10, 32)).toEqual([0, 0, 255, 255]);
    }
  });
  it('keeps dim and cursor geometry in screen space; animated invisible holes retain alpha', async () => {
    const e = new AnimationEngine(doc, dir); await e.prepare();
    expect(e.measureLayout(0).layers.find(l => l.id === 'dim')!.screenBounds).toEqual({ left: 0, top: 0, right: 100, bottom: 100 });
    const a = { width: 100, data: (await e.renderFrame(0)).rgba() };
    expect(pixel(a, 50, 50)[0]).toBeGreaterThan(245); expect(pixel(a, 95, 95)[0]).toBeLessThan(110);
    const b = { width: 100, data: (await e.renderFrame(10)).rgba() };
    expect(pixel(b, 80, 50)[0]).toBeGreaterThan(245); expect(pixel(b, 35, 50)[0]).toBeLessThan(110);
    expect(e.evaluate(10).byId.get('outline')!.shape!.cornerRadius).toBe(6);
  });
  it('has repeatable pixels across two engine instances and rendering order', async () => {
    const p = await fixture(); const mixed = { ...doc, assets: { v: p.asset }, layers: [{ id: 'video', asset: 'v', sourceTime: 0.4, x: 50, y: 50, width: 100, height: 100, z: -1 }, ...doc.layers] };
    const a = new AnimationEngine(mixed, dir), b = new AnimationEngine(structuredClone(mixed), dir); await a.prepare(); await b.prepare();
    try { const h = hash((await a.renderFrame(6)).rgba()); await a.renderFrame(10); expect(hash((await a.renderFrame(6)).rgba())).toBe(h); expect(hash((await b.renderFrame(6)).rgba())).toBe(h); }
    finally { await a.closeVideoSources(); await b.closeVideoSources(); }
  }, 120000);
});
describe('validation and pure timing', () => {
  const codes = (doc: unknown) => validateScene(doc, { checkFiles: false }).errors.map(e => e.code);
  it('rejects unprepared media, conflicting content, malformed shapes/path and audio range', () => {
    expect(codes(baseScene({ assets: { v: { src: 'a.mp4', kind: 'video' } } }))).toContain('VIDEO_NOT_PREPARED');
    expect(codes(baseScene({ layers: [{ id: 's', shape: { type: 'rect' }, fill: '#fff' }] }))).toContain('CONFLICTING_CONTENT');
    expect(codes(baseScene({ layers: [{ id: 's', shape: { type: 'triangle' } }] }))).toContain('INVALID_SHAPE');
    expect(codes(baseScene({ layers: [{ id: 's', shape: { type: 'path', d: 'M0 0 L eval(1)' } }] }))).toContain('INVALID_PATH_DATA');
    expect(codes(baseScene({ audio: [{ src: 'a.wav', sourceIn: 2, sourceOut: 1 }] }))).toContain('INVALID_AUDIO_RANGE');
    expect(validateScene(baseScene({ assets: { v: { kind: 'video', src: 'missing.mp4' } } }), { baseDir: dir }).errors.map(e => e.code)).toContain('MISSING_VIDEO_FILE');
  });
  it('reports exact clamped frame ranges including step changes', () => {
    const p = { kind: 'video', src: 'v.mp4', video: { width: 96, height: 32, fps: 30, frameCount: 80, duration: 80 / 30, preparedBy: 'prepare_video_asset@1', sha256: '0'.repeat(64) } };
    const d = videoScene(p); d.animations[0].keyframes = [{ frame: 0, value: -1, interpolation: 'step' }, { frame: 4, value: 0 }];
    const v = validateScene(d, { checkFiles: false }); expect(v.warnings.find(w => w.code === 'SOURCE_TIME_OUT_OF_RANGE')!.details!.frames).toEqual([[0, 3]]);
    expect(evaluateScene(SceneSchema.parse(d), 0, () => undefined).layers[0].sourceFrame).toBe(0);
  });
  it('writes RTL and Korean word boundaries, trims and offsets, without splitting words', () => {
    const blocks = [{ startFrame: 30, startOffsetMs: 12, sourceIn: 2, sourceOut: 4, timing: { words: [{ word: 'سلام', start: 2, end: 2.4 }, { word: 'دنیا.', start: 2.5, end: 3 }] } }];
    const r = subtitlesFromTiming(blocks, { fps: 30, maxCharacters: 6 });
    expect(r.srt).toBe('1\n00:00:01,012 --> 00:00:02,012\n\u202bسلام\u202c\n\u202bدنیا.\u202c\n');
    expect(r.ass).toContain('Dialogue: 0,0:00:01.01,0:00:02.01');
    const ko = subtitlesFromTiming([{ startFrame: 0, timing: { words: [{ word: '한국어', start: 0, end: 0.4 }, { word: '자막.', start: 0.5, end: 1 }] } }], { fps: 30, maxCharacters: 4 });
    expect(ko.cues[0].lines).toEqual(['한국어', '자막.']);
  });
  it('stages hostile subtitle paths under safe filenames and reports missing files', async () => {
    await expect(stageSubtitles({ file: 'missing.srt', mode: 'soft' }, dir)).rejects.toMatchObject({ code: 'MISSING_SUBTITLE_FILE' });
    const name = "quote':;[x].srt"; await fs.writeFile(path.join(dir, name), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    const staged = await stageSubtitles({ file: name, mode: 'soft' }, dir);
    try { expect(staged.file).toBe('captions.srt'); } finally { await staged.cleanup(); }
  });
  it('offsets soft subtitle timestamps when encoding a scene subrange', async () => {
    const file = path.join(dir, 'range.srt');
    await fs.writeFile(file, '1\n00:00:01,500 --> 00:00:02,500\nrange cue\n');
    const e = new AnimationEngine(baseScene({ canvas: { width: 32, height: 32, fps: 30 }, duration: 90 }), dir);
    await e.prepare();
    const out = path.join(dir, 'range.mp4');
    await e.renderVideo(out, { startFrame: 30, subtitles: { file, mode: 'soft' } });
    const extracted = path.join(dir, 'extracted.srt');
    await runFFmpeg(['-v', 'error', '-i', out, '-map', '0:s:0', '-y', extracted]);
    expect(await fs.readFile(extracted, 'utf8')).toContain('00:00:00,500 --> 00:00:01,500');
  }, 60000);
  it('rolls back invalid audio edits through the tool API', async () => {
    const session = new EngineSession(); await session.call('create_scene', {});
    expect((await session.call('add_audio', { track: { src: 'n.wav', sourceIn: 1, sourceOut: 2 } })).ok).toBe(true);
    const before = structuredClone(session.doc);
    expect((await session.call('update_audio', { index: 0, patch: { sourceOut: 0.5 } })).ok).toBe(false);
    expect(session.doc).toEqual(before);
    expect((await session.call('remove_audio', { index: 0 })).ok).toBe(true);
  });
  it('reports actual shaping diagnostics using explicit fixture fonts', async () => {
    const caps = await mediaCapabilities(path.resolve('examples/footage-proof/fonts'));
    expect(typeof caps.subtitles.burn).toBe('boolean');
    if (caps.subtitles.complexShaping) expect(caps.subtitles.diagnostics).toMatch(/HarfBuzz/i);
    else expect(caps.subtitles.reason).toBeTruthy();
  }, 60000);
});
