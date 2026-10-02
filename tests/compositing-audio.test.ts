import { it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AnimationEngine } from '../src/api/engine.js';
import { runFFmpeg, ffprobePath } from '../src/media/process.js';
import { tmpDir } from './helpers.js';
const dir = tmpDir('ae-audio-trim-');
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
it.each([0, 12])('places a trimmed tone within one millisecond in a render starting at frame %i', async startFrame => {
  const rate = 48000, pcm = Buffer.alloc(rate * 3 * 2);
  // Short tapered tone at source 1.2 seconds, plus a different tone beyond sourceOut.
  for (let i = 0; i < rate * 3; i++) {
    const t = i / rate;
    const start = t < 2 ? 1.2 : 2.2, u = t - start;
    const amp = u >= 0 && u < 0.1 ? Math.sin(Math.PI * u / 0.1) ** 2 : 0;
    pcm.writeInt16LE(Math.round(22000 * amp * Math.sin(2 * Math.PI * (t < 2 ? 1300 : 2600) * u)), i * 2);
  }
  await fs.writeFile(path.join(dir, 'source.pcm'), pcm);
  await runFFmpeg(['-v', 'error', '-f', 's16le', '-ar', String(rate), '-ac', '1', '-i', path.join(dir, 'source.pcm'), '-y', path.join(dir, 'source.wav')]);
  const e = new AnimationEngine({ canvas: { width: 32, height: 32, fps: 30 }, duration: 90, audio: [{ src: 'source.wav', startFrame: 10, startOffsetMs: 12, sourceIn: 1, sourceOut: 1.8, fadeInMs: 10, fadeOutMs: 30 }] }, dir);
  await e.prepare(); await e.renderVideo(path.join(dir, 'out.mp4'), { startFrame });
  const probe = spawnSync(ffprobePath(), ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-of', 'json', path.join(dir, 'out.mp4')], { encoding: 'utf8' });
  expect(probe.status, probe.stderr).toBe(0);
  const timestamps = JSON.parse(probe.stdout).packets.map((p: { pts_time: string }) => Number(p.pts_time)) as number[];
  const clipEnd = (10 - startFrame) / 30 + 0.012 + 0.8;
  expect(timestamps.length).toBeGreaterThan(1);
  for (let i = 0; i < timestamps.length; i++) {
    expect(Number.isFinite(timestamps[i])).toBe(true);
    expect(timestamps[i]).toBeGreaterThanOrEqual(-0.022); // AAC priming packet
    expect(timestamps[i]).toBeLessThanOrEqual(clipEnd + 0.025);
    if (i) expect(timestamps[i]).toBeGreaterThan(timestamps[i - 1]);
  }
  await runFFmpeg(['-v', 'error', '-i', path.join(dir, 'out.mp4'), '-vn', '-ar', String(rate), '-ac', '1', '-f', 's16le', '-y', path.join(dir, 'decoded.pcm')]);
  const result = await fs.readFile(path.join(dir, 'decoded.pcm'));
  expect(result.length).toBeGreaterThanOrEqual(Math.floor((clipEnd - 0.025) * rate) * 2);
  const expected = Math.round(((10 - startFrame) / 30 + 0.012 + 0.2) * rate), length = 4800;
  // Cross-correlate the full known envelope, avoiding codec pre-echo onset heuristics.
  let bestOffset = 0, best = -Infinity;
  for (let offset = -96; offset <= 96; offset++) {
    let score = 0;
    for (let i = 0; i < length; i++) score += pcm.readInt16LE((57600 + i) * 2) * result.readInt16LE((expected + offset + i) * 2);
    if (score > best) { best = score; bestOffset = offset; }
  }
  expect(Math.abs(bestOffset)).toBeLessThanOrEqual(48);
  const late = result.subarray(Math.floor(1.2 * rate) * 2);
  let peak = 0; for (let i = 0; i + 1 < late.length; i += 2) peak = Math.max(peak, Math.abs(late.readInt16LE(i)));
  expect(peak).toBeLessThan(100);
}, 60000);
