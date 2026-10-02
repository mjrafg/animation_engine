import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { McpStdioClient } from './client.js';
import { tmpDir } from '../helpers.js';
import { runFFmpeg } from '../../src/media/process.js';
let client: McpStdioClient;
const root = tmpDir('ae-mcp-compositing-');
beforeAll(async () => {
  client = new McpStdioClient({ VIDEO_ENGINE_ROOT: root }); await client.initialize();
  await client.ok('workspace_create', { workspaceId: 'media' });
  await client.ok('scene_create', { workspaceId: 'media', sceneId: 's', canvas: { width: 96, height: 64, fps: 30 }, duration: 30 });
});
afterAll(async () => { await client?.close(); fs.rmSync(root, { recursive: true, force: true }); });
it('prepares video as a job, draws shape and video layers, and exposes resolved source frames', async () => {
  await runFFmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=30:d=1', '-c:v', 'libx264', '-y', path.join(root, 'media/inbox/source.mp4')]);
  const job = await client.ok('prepare_video_asset', { workspaceId: 'media', sceneId: 's', input: 'source.mp4', assetId: 'v' });
  let status: any;
  do { status = await client.ok('render_video_status', { workspaceId: 'media', renderId: job.renderId, waitSeconds: 45 }); } while (['queued', 'running'].includes(status.status));
  expect(status.status).toBe('completed'); expect(status.result.entry.kind).toBe('video');
  await client.ok('layer_add', { workspaceId: 'media', sceneId: 's', layers: [
    { id: 'v', asset: 'v', x: 48, y: 32, sourceTime: 0.5 },
    { id: 'circle', x: 48, y: 32, width: 20, height: 20, space: 'screen', shape: { type: 'ellipse', stroke: '#fff', strokeWidth: 2 } },
  ] });
  const measured = await client.ok('measure_layout', { workspaceId: 'media', sceneId: 's', frame: 0 });
  expect(JSON.stringify(measured)).toContain('"sourceFrame":15');
  const frame = await client.ok('render_frame', { workspaceId: 'media', sceneId: 's', frame: 0 });
  expect(frame.artifact.bytes).toBeGreaterThan(0);
}, 120000);
it('generates subtitle artifacts and rejects workspace path escapes', async () => {
  const r = await client.ok('subtitles_from_timing', { workspaceId: 'media', blocks: [{ startFrame: 0, timing: { words: [{ word: '한국어.', start: 0, end: 1 }] } }], options: { fps: 30 } });
  expect(fs.readFileSync(path.join(root, 'media', r.srt), 'utf8')).toContain('한국어.');
  const job = await client.ok('prepare_video_asset', { workspaceId: 'media', input: '../../escape.mp4' });
  const status = await client.ok('render_video_status', { workspaceId: 'media', renderId: job.renderId, waitSeconds: 45 });
  expect(status.error.code).toBe('PATH_OUTSIDE_WORKSPACE');
});
