#!/usr/bin/env node
/**
 * Registers (or updates) the video engine MCP server as a Tandem MCP integration through
 * Tandem's own admin API, then runs Tandem's connection test and tool discovery.
 *
 *   TANDEM_URL=http://127.0.0.1:7810 TANDEM_EMAIL=admin@example.com TANDEM_PASSWORD=... \
 *   VIDEO_ENGINE_DIR=/opt/animation_engine VIDEO_ENGINE_ROOT=/srv/tandem/video-workspaces \
 *   [VIDEO_ENGINE_LIBRARIES="kitchen=/srv/video-libraries/kitchen;models=/opt/animation_engine/assets/3d;characters=/opt/animation_engine/assets/characters"] \
 *   [BLENDER_PATH=/usr/bin/blender] \
 *   node integrations/tandem/register.mjs
 *
 * Result in Tandem: Settings → Integrations → "Video Engine" (type mcp, transport stdio), its 49
 * tools served to the Builder as video_engine_<tool> through the tandem_ext gateway.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (process.env.TANDEM_URL ?? "http://127.0.0.1:7810").replace(/\/+$/, "");
const email = process.env.TANDEM_EMAIL;
const password = process.env.TANDEM_PASSWORD;
const engineDir = path.resolve(process.env.VIDEO_ENGINE_DIR ?? path.join(here, "../.."));
const root = process.env.VIDEO_ENGINE_ROOT;
if (!email || !password || !root) {
  console.error("Set TANDEM_EMAIL, TANDEM_PASSWORD and VIDEO_ENGINE_ROOT (see header).");
  process.exit(2);
}

const env = { VIDEO_ENGINE_ROOT: path.resolve(root) };
if (process.env.VIDEO_ENGINE_LIBRARIES) env.VIDEO_ENGINE_LIBRARIES = process.env.VIDEO_ENGINE_LIBRARIES;
if (process.env.VIDEO_ENGINE_WORKSPACE) env.VIDEO_ENGINE_WORKSPACE = process.env.VIDEO_ENGINE_WORKSPACE;
if (process.env.FFMPEG_PATH) env.FFMPEG_PATH = process.env.FFMPEG_PATH;
// optional 3D backend: Blender on PATH, or an explicit binary
if (process.env.BLENDER_PATH) env.BLENDER_PATH = process.env.BLENDER_PATH;

const integration = {
  name: "Video Engine",
  type: "mcp",
  config: {
    transport: "stdio",
    command: process.env.VIDEO_ENGINE_NODE ?? "node",
    args: [path.join(engineDir, "dist", "video-engine-mcp.mjs")],
    env,
  },
};

let cookie = "";
async function api(method, p, body) {
  const res = await fetch(url + p, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${JSON.stringify(data)}`);
  return data;
}

await api("POST", "/api/login", { email, password });
const existing = (await api("GET", "/api/integrations")).find((i) => i.slug === "video_engine");
const saved = existing
  ? await api("PATCH", `/api/integrations/${existing.id}`, { config: integration.config, enabled: true })
  : await api("POST", "/api/integrations", integration);
console.log(`${existing ? "Updated" : "Created"} integration ${saved.name} (slug ${saved.slug}, id ${saved.id})`);
const test = await api("POST", `/api/integrations/${saved.id}/test`);
console.log(`Connection test: ${test.ok ? "OK" : "FAILED"} — ${test.detail}`);
if (!test.ok) process.exit(1);
const refreshed = await api("POST", `/api/integrations/${saved.id}/refresh-tools`);
const tools = (refreshed.integration ?? (await api("GET", "/api/integrations")).find((i) => i.id === saved.id)).tools;
console.log(`Discovered ${tools.length} tools: ${tools.map((t) => t.fullName).join(", ")}`);
