# Video Engine MCP server

`video-engine-mcp` exposes the deterministic 2D video engine to agents over the
[Model Context Protocol](https://modelcontextprotocol.io). An agent can do everything through
structured tools: inspect capabilities, manage assets, build and animate scenes, measure layout,
look at previews and render MP4s. It never imports engine code, writes per-video scripts, calls
FFmpeg or needs host paths.

```text
Tandem agent ──MCP (stdio)──► video-engine-mcp (mcp/src)          thin adapter: args → core call → JSON
                                   │
                                   ▼
                              engine core (src/)                  one implementation of all behaviour
                              ├─ workspace/  WorkspaceManager, VideoWorkspace, RenderJobs, path safety
                              ├─ api/        scene operations (layers, batch timeline), AnimationEngine
                              ├─ scene/      Zod schemas (shared with MCP), validation
                              ├─ assets/     inspection, background removal, trim, components
                              └─ render/     Skia renderer, FFmpeg pipe encoder
```

The MCP layer holds no scene logic. It validates arguments against the **core engine's Zod
schemas** (`LayerSchema`, `TimelineOpSchema`, `CameraSchema`, …), calls the core, and shapes the
result. All other behaviour is in the core and usable without MCP:

- ID-based workspaces with path isolation
- atomic validated scene mutations
- asset derivation with provenance
- render jobs
- capability discovery
- stable error codes

The transport is attached in `mcp/src/main.ts` (stdio). `createVideoEngineServer()` in
`mcp/src/server.ts` is transport-agnostic, so a Streamable HTTP transport can be added without
changing any tool.

## Install and run (Linux, headless)

Runtime requirements:

- **Node.js ≥ 20** (tested on 22).
- **FFmpeg:** bundled through the `ffmpeg-static` npm package (static Linux x64/arm64 binary). Override with `FFMPEG_PATH` to use a system build.
- **Skia:** `@napi-rs/canvas` ships prebuilt Linux binaries (glibc and musl, x64 and arm64). It needs no system libraries, no X server and no GPU.
- **Image I/O:** `sharp` ships prebuilt libvips.
- **Fonts:** only the debug-preview labels use text; any installed sans/mono font works (DejaVu or Liberation recommended).
- **3D (optional):**
  - Blender ≥ 3.6 headless (tested: 4.0.2 from apt) with `python3-numpy`, plus `libegl1 libegl-mesa0 libgl1-mesa-dri` for the fast EEVEE renderer. Without them 3D falls back to Cycles on the CPU; without Blender at all, 3D tools return `ENGINE_CAPABILITY_UNAVAILABLE` and 2D is unaffected.
  - Details: [`docs/3D.md`](../docs/3D.md).

```bash
git clone <repo> /opt/animation_engine && cd /opt/animation_engine
npm ci
npm run build:mcp                      # -> dist/video-engine-mcp.mjs (bundled; native deps stay in node_modules)
node dist/video-engine-mcp.mjs --version
node dist/video-engine-mcp.mjs --self-test --root /srv/video-workspaces   # FFmpeg, renderer, sharp, real MP4 encode; exit 0/1
node dist/video-engine-mcp.mjs --list-tools                               # tool definitions as JSON
npm link                               # optional: puts `video-engine-mcp` on PATH (bin/video-engine-mcp.js)
```

Configuration comes from flags or environment. Tandem passes environment variables per integration.

| Env | Flag | Meaning |
|---|---|---|
| `VIDEO_ENGINE_ROOT` | `--root` | Directory holding all workspaces (default `~/.video-engine/workspaces`) |
| `VIDEO_ENGINE_WORKSPACE` | `--workspace` | Lock the server to ONE workspace id; every other id → `WORKSPACE_FORBIDDEN` |
| `VIDEO_ENGINE_LIBRARIES` | `--library name=/dir` | Read-only asset libraries, `name=/dir;name2=/dir2` |
| `VIDEO_ENGINE_LOG` | `--log` | JSONL operation log (default `<root>/.logs/mcp.jsonl`) |
| `VIDEO_ENGINE_MAX_RENDERS` | | Concurrent video renders per workspace (default 1) |
| `FFMPEG_PATH` | | FFmpeg binary (default: bundled) |
| `BLENDER_PATH` | | Blender binary for 3D (default: `blender` on PATH) |
| `VIDEO_ENGINE_3D_ENGINE` | | `cycles` forces the CPU path tracer (default: EEVEE when it works) |
| `VIDEO_ENGINE_3D_DEVICE` | | `GPU` lets Cycles use CUDA/OptiX/HIP/oneAPI when present |

- **stdout** carries only MCP JSON-RPC.
- **stderr** is silent except for startup failures. Tandem does not drain the child's stderr, so the server never writes to it during normal operation.
- **Shutdown:** SIGTERM, SIGINT or stdin closing marks running render jobs `interrupted` and exits.
- **Startup:** it listens as soon as it is spawned; there is no warm-up.

## Workspaces, ids and paths

```text
<root>/<workspaceId>/
  inbox/                  drop files here, then asset_import {source:{inbox:"file.png"}}
  assets/<assetId>/       one directory per asset (+ view.jpg, processing byproducts)
  scenes/<sceneId>.json   engine scene documents
  previews/ frames/ renders/ artifacts/ jobs/
```

- Every tool takes an explicit `workspaceId`. Workspace, asset, scene, layer, artifact and render ids are the interface.
- **Inputs never accept host paths.** File inputs are relative paths that must resolve inside a known root: a library, or the workspace inbox.
- `..` segments, absolute paths and symlinks that point outside the root are rejected with `PATH_OUTSIDE_WORKSPACE`.
- **Outputs** carry `relativePath` (workspace-relative) plus `path` and `viewPath` (absolute) so the agent can open them with its file viewer. `viewPath` is a JPEG of at most 960 px and about 140 KB, under Tandem's 150 KB image-read guard. Transparent assets are shown over a checkerboard.
- **Asset reuse:** layers reference assets by id (`"asset": "cup"`). Any number of layers and scenes use one asset file, and re-importing identical bytes returns the existing asset (`reused: true`).
- **Processing is non-destructive:** `asset_process`, `asset_trim` and `asset_component_remove` create a new asset whose `provenance` names its source.

## Tools (40)

| Group | Tools |
|---|---|
| Engine | `engine_capabilities`, `engine_version`, `engine_health` |
| Workspace | `workspace_create`, `workspace_open`, `workspace_info`, `workspace_list` |
| Assets | `library_list`, `asset_import`, `asset_list`, `asset_get`, `asset_update`, `asset_inspect`, `asset_process`, `asset_trim`, `asset_components`, `asset_component_remove` |
| Scenes | `scene_create`, `scene_get`, `scene_list`, `scene_update`, `scene_delete` |
| Layers | `layer_add` (batch), `layer_update` (multi-property / multi-layer, atomic), `layer_remove`, `layer_list` |
| Timeline | `timeline_get`, `timeline_apply` (atomic batch: `keyframe.add/update/remove`, `track.set/remove`; target = layer id or `camera`) |
| Layout & render | `measure_layout`, `render_preview` (`debug`), `render_frame`, `render_video_start`, `render_video_status` (`waitSeconds` ≤ 45), `render_video_cancel`, `artifact_list` |
| 3D | `object_add`, `object_update`, `object_remove`, `object_list`, `scene_settings_3d`. `scene_create kind:"3d"`; timeline, measure and render tools work on both kinds. |

**3D scenes** (see [`docs/3D.md`](../docs/3D.md)):

- Import `.glb` models like any asset; `asset_inspect` lists clips, sockets and morph targets and shows a thumbnail.
- Add models, primitives and lights with `object_add`.
- Attach props to bones: `attach:{object:"hero", bone:"rightHand"}`.
- Switch clips and animate transforms, morphs and the camera with `timeline_apply`.
- Check framing and hand positions with `measure_layout`, then render as usual.
- A 2D scene can be overlaid on a 3D one (`scene_settings_3d overlay`).

- Tools are deliberately coarse: one `layer_update` changes any number of properties at once.
- `engine_capabilities` is derived from the engine's own tables (animatable properties, interpolations, mask types, batch operation types), so it stays accurate as the engine evolves.

### Scene semantics (also in the tool and field descriptions)

- **Coordinates:** canvas pixels, origin top-left, +y down, rotation in degrees clockwise. Frames are `0 … duration-1`.
- **Position:** a layer's `x`/`y` place its **pivot**, in the parent's pivot space. `anchorX`/`anchorY` (0..1) choose the pivot inside the box; rotation and scale happen around it.
- **Parenting:** `parent` means transform inheritance only. `z` alone decides the **global** draw order. For example, a forearm parented to the upper arm can be `z: 30` and draw above a `z: 20` counter while the torso (`z: 10`) stays behind it.
- **Keyframe interpolation** shapes the segment to the next key. `asset`, `visible`, `z` and `fill` are step-only. The camera animates `x`, `y`, `scale` and `rotation` through the same timeline.

### Example calls

```jsonc
// layer_update — several properties, one atomic call
{"workspaceId":"kitchen-e2e","sceneId":"shot1","layerId":"woman","patch":{"x":720,"y":340,"scaleX":0.82,"scaleY":0.82,"rotation":4,"z":30}}

// timeline_apply — atomic batch, errors name operations[i]
{"workspaceId":"kitchen-e2e","sceneId":"shot1","operations":[
  {"type":"keyframe.add","target":"woman","property":"x","frame":30,"value":650,"interpolation":"linear"},
  {"type":"keyframe.add","target":"woman","property":"x","frame":90,"value":920,"interpolation":"ease-in-out"},
  {"type":"keyframe.add","target":"mouth","property":"asset","frame":44,"value":"mouth_A","interpolation":"step"},
  {"type":"keyframe.add","target":"camera","property":"scale","frame":90,"value":1.2,"interpolation":"ease-in-out"}]}

// render_video_start → render_video_status {"renderId":"render_3","waitSeconds":40}
{"renderId":"render_3","status":"completed","progress":1,"artifactId":"video_2","relativePath":"renders/shot1_video_2.mp4","durationSeconds":4}
```

### Errors

A failed call is an MCP tool error (`isError: true`) whose text is:

```json
{"error":{"code":"LAYER_NOT_FOUND","message":"No layer \"woman_02\"","details":{"sceneId":"shot1","issues":[{"code":"MISSING_LAYER","path":["id"],"message":"No layer \"woman_02\""}]}}}
```

Stable codes:

- **Workspace and paths:** `WORKSPACE_NOT_FOUND`, `WORKSPACE_EXISTS`, `WORKSPACE_FORBIDDEN`, `INVALID_ID`, `PATH_OUTSIDE_WORKSPACE`, `LIBRARY_NOT_FOUND`, `FILE_NOT_FOUND`.
- **Assets:** `ASSET_NOT_FOUND`, `ASSET_EXISTS`, `INVALID_ASSET`, `PROCESSING_FAILED`.
- **Scenes and animation:** `SCENE_NOT_FOUND`, `SCENE_EXISTS`, `LAYER_NOT_FOUND`, `INVALID_PARENT`, `PARENT_CYCLE`, `INVALID_KEYFRAME`, `TRACK_NOT_FOUND`, `INVALID_FRAME`, `UNSUPPORTED_PROPERTY`, `VALIDATION_FAILED`.
- **Rendering:** `ARTIFACT_NOT_FOUND`, `RENDER_NOT_FOUND`, `RENDER_FAILED`, `RENDER_CANCELLED`, `RENDER_INTERRUPTED`, `FFMPEG_FAILED`.
- **Requests and internal:** `INVALID_ARGUMENT` (argument schema), `UNKNOWN_TOOL`, `INTERNAL_ERROR`.

Mutations validate the full scene before writing. A failed call leaves the stored scene
byte-for-byte unchanged, and the server stays up after invalid requests or malformed input.

### Long renders

`render_video_start` returns immediately. The render runs in the server process, persisting
`frame`, `totalFrames` and `progress` to `jobs/<renderId>.json`.

- **Polling:** `render_video_status` reports progress. With `waitSeconds` it long-polls, staying under Tandem's 60 s per-call timeout.
- **Cancelling:** `render_video_cancel` kills FFmpeg and deletes the partial file.
- **Interruption:** a job left running by a server process that stopped is reported as `interrupted`.
- **Missing inputs:** a scene whose asset files disappeared fails up front with `ASSET_NOT_FOUND`. The engine cache checks file state.

## Logging

Tandem's gateway records every call as a `tool_call` timeline event with tool, sanitized args,
status, duration and the first 4 KB of the result. Every result starts with a `summary`,
followed by `artifactId`s. The server additionally appends one JSONL line per call to
`VIDEO_ENGINE_LOG`:

```json
{"ts":"…","pid":123,"tool":"render_preview","args":{…},"durationMs":231,"ok":true,"summary":"Preview preview_4: shot1 frame 90","artifacts":["preview_4"]}
```

It logs error codes and messages on failure, and replaces base64 payloads with their length.

## Tandem registration

Tandem already runs external MCP servers as **Integrations** of type `mcp`: Admin → Settings →
Integrations, or the `/api/integrations` API. It spawns the configured stdio command with `PATH`,
`HOME` and the configured env, discovers tools via `tools/list`, and serves them to the Builder
as `video_engine_<tool>` through its `tandem_ext` gateway. It enforces roles, a 60 s timeout per
call and a 5 min idle close. The configuration is:

```json
{
  "name": "Video Engine",
  "type": "mcp",
  "config": {
    "transport": "stdio",
    "command": "node",
    "args": ["/opt/animation_engine/dist/video-engine-mcp.mjs"],
    "env": {
      "VIDEO_ENGINE_ROOT": "/srv/tandem/video-workspaces",
      "VIDEO_ENGINE_LIBRARIES": "kitchen=/opt/animation_engine/examples/kitchen/assets/originals"
    }
  }
}
```

`integrations/tandem/register.mjs` creates or updates the integration through Tandem's API,
then runs Tandem's connection test and tool discovery:

```bash
TANDEM_URL=http://127.0.0.1:7810 TANDEM_EMAIL=admin@example.com TANDEM_PASSWORD=… \
VIDEO_ENGINE_DIR=/opt/animation_engine VIDEO_ENGINE_ROOT=/srv/tandem/video-workspaces \
VIDEO_ENGINE_LIBRARIES="kitchen=/opt/animation_engine/examples/kitchen/assets/originals" \
node integrations/tandem/register.mjs
# Created integration Video Engine (slug video_engine, …)
# Connection test: OK — Connected — the server reports 40 tools.
# Discovered 40 tools: video_engine_artifact_list, …
```

Integration tools default to the `builder` role. Grant `reviewer` in Settings → Integrations if a
Reviewer should render previews too. The Tandem service user needs write access to
`VIDEO_ENGINE_ROOT` and read access to library directories. The Builder opens `viewPath` files
with its Read tool.

## Tests

```bash
npm test          # core engine + workspace tests, and MCP tests if dist/ is built
npm run test:mcp  # builds dist/ then runs tests/mcp over real stdio with a Tandem-like client
```
