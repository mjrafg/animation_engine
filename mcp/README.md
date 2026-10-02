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

| Env                        | Flag                  | Meaning                                                                     |
| -------------------------- | --------------------- | --------------------------------------------------------------------------- |
| `VIDEO_ENGINE_ROOT`        | `--root`              | Directory holding all workspaces (default `~/.video-engine/workspaces`)     |
| `VIDEO_ENGINE_WORKSPACE`   | `--workspace`         | Lock the server to ONE workspace id; every other id → `WORKSPACE_FORBIDDEN` |
| `VIDEO_ENGINE_LIBRARIES`   | `--library name=/dir` | Read-only asset libraries, `name=/dir;name2=/dir2`                          |
| `VIDEO_ENGINE_LOG`         | `--log`               | JSONL operation log (default `<root>/.logs/mcp.jsonl`)                      |
| `VIDEO_ENGINE_MAX_RENDERS` |                       | Concurrent video renders per workspace (default 1)                          |
| `FFMPEG_PATH`              |                       | FFmpeg binary (default: bundled)                                            |
| `BLENDER_PATH`             |                       | Blender binary for 3D (default: `blender` on PATH)                          |
| `VIDEO_ENGINE_3D_ENGINE`   |                       | `cycles` forces the CPU path tracer (default: EEVEE when it works)          |
| `VIDEO_ENGINE_3D_DEVICE`   |                       | `GPU` lets Cycles use CUDA/OptiX/HIP/oneAPI when present                    |

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

## Tools (54)

| Group           | Tools                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine          | `engine_capabilities`, `engine_version`, `engine_health`                                                                                                                                                                                                                                                                                                              |
| Workspace       | `workspace_create`, `workspace_open`, `workspace_info`, `workspace_list`                                                                                                                                                                                                                                                                                              |
| Assets          | `library_list`, `asset_import`, `asset_list`, `asset_get`, `asset_update`, `asset_inspect`, `asset_process`, `asset_trim`, `asset_components`, `asset_component_remove`                                                                                                                                                                                               |
| Scenes          | `scene_create`, `scene_get`, `scene_list`, `scene_update`, `scene_delete`                                                                                                                                                                                                                                                                                             |
| Layers          | `layer_add` (batch), `layer_update` (multi-property / multi-layer, atomic), `layer_remove`, `layer_list`                                                                                                                                                                                                                                                              |
| Timeline        | `timeline_get`, `timeline_apply` (atomic batch: `keyframe.add/update/remove`, `track.set/remove`; target = layer id or `camera`)                                                                                                                                                                                                                                      |
| Layout & render | `measure_layout`, `render_preview` (`debug`), `render_frame`, `render_video_start`, `render_video_status` (`waitSeconds` ≤ 45), `render_video_cancel`, `artifact_list`                                                                                                                                                                                                |
| Characters      | `character_list`, `character_import`, `character_inspect`, `character_add`, `character_update`, `character_remove`, `character_actions` (atomic high-level action batch), `character_timeline`, `speech_timing_save`                                                                                                                                                  |
| 3D              | `object_add`, `object_update`, `object_remove`, `object_list`, `scene_settings_3d`. `scene_create kind:"3d"`; timeline, measure and render tools work on both kinds.                                                                                                                                                                                                  |
| Interactions    | `interaction_list` (built-in + custom, full description), `interaction_check` (compatibility and fit for given characters/sizes), `interaction_define` (custom definition as data), `interaction_apply` (atomic batch: add/update/replace/remove/shift/clear), `interaction_inspect` (phases, alignment, contacts, transfers, ownership; measured contact at a frame) |

**Multi-character interactions** (see [`docs/INTERACTIONS.md`](../docs/INTERACTIONS.md)): place the characters, then `interaction_apply {operations: [{type: "add", interaction: {interaction: "handshake", actors: ["a", "b"], start: 11, duration: 3}}]}`. The runtime aligns, approaches, reaches, holds contact, hands objects over and returns, and it rejects overlapping walks, turns or gestures with `ACTION_CONFLICT` naming the interaction.

**Prepared characters** (see [`docs/CHARACTERS.md`](../docs/CHARACTERS.md)):

- `character_import` a package from a library once.
- `character_add` it to a 2D or 3D scene.
- Schedule `walk`/`run`/`idle`/`talk`/`smile`/`blink`/`wave`/`point`/`turn`/`look` with `character_actions`; one call can hold a whole performance.
- Speech timing (visemes, characters or words) is saved with `speech_timing_save`.
- Generated tracks carry `owner`, and low-level edits to them are refused (`OWNED_BY_CHARACTER`).

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
{
  "error": {
    "code": "LAYER_NOT_FOUND",
    "message": "No layer \"woman_02\"",
    "details": { "sceneId": "shot1", "issues": [{ "code": "MISSING_LAYER", "path": ["id"], "message": "No layer \"woman_02\"" }] }
  }
}
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
# Connection test: OK — Connected — the server reports 49 tools.
# Discovered 49 tools: video_engine_artifact_list, …
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

## Video compositing extensions

`engine_capabilities` includes `media.videoDecode`, `media.ffmpeg`,
`media.subtitles.burn` and `media.subtitles.complexShaping` with a reason/diagnostics.
Set `VIDEO_ENGINE_FONTS_DIR` to an explicit font directory to run the Persian and
Korean shaping probe. `FFMPEG_PATH` and `FFPROBE_PATH` override the bundled binaries.

| Tool                                          | Arguments and result                                                                                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare_video_asset`                         | `workspaceId`, inbox-relative `input`, optional `sceneId`, `assetId`, `options: {fps,width,height,fit,gop}`. Returns a job id; defaults fps from scene or 30.                                                                                     |
| `render_video_status` / `render_video_cancel` | Preparation uses the existing persisted queue, cancellation and recovery. Completed preparation has `result.asset`, `result.entry`, warnings.                                                                                                     |
| `layer_add` / `layer_update`                  | Accept `shape`, `sourceTime`, `space` through the scene schema.                                                                                                                                                                                   |
| `add_audio`                                   | `workspaceId`, `sceneId`, `track: {assetId,startFrame,sourceIn?,sourceOut?,startOffsetMs?,fadeInMs?,fadeOutMs?,volume?}`; returns track index.                                                                                                    |
| `update_audio`                                | `workspaceId`, `sceneId`, `index`, `patch`; use `assetId` to replace source, null to remove optional fields. Host paths are rejected.                                                                                                             |
| `remove_audio`                                | `workspaceId`, `sceneId`, `index`.                                                                                                                                                                                                                |
| `subtitles_from_timing`                       | `workspaceId`, `blocks: [{timing,startFrame,startOffsetMs?,sourceIn?,sourceOut?}]`, `options: {fps,width?,height?,maxCharacters?,maxLines?,minDuration?,maxDuration?,pauseThreshold?,style?}`. Returns workspace-relative ASS/SRT paths and cues. |
| `render_video_start`                          | Adds `subtitles: {file,mode,fontsDir?}` (workspace-relative paths) and `chunks` 1–16.                                                                                                                                                             |
| `measure_layout`                              | Video layers include `sourceTime` and `sourceFrame` in compact/full results.                                                                                                                                                                      |
| `asset_list`                                  | Supports `kind: "video"`; prepared records include hash and stream metadata.                                                                                                                                                                      |

Prepared video is CFR H.264/yuv420p, without audio, with a recorded byte hash.
Edits and loads reject missing, unprepared or modified video. `sourceTime` is a
continuous timeline property in seconds; source frame is floor(time × fps + 1e-6),
clamped at either end. Several layers may reference one asset at different times.

Shape fields: `type` rect/ellipse/path, `d` (path only), `cornerRadius`, `fill`,
`stroke`, `strokeWidth`, `strokeAlign` inside/center/outside, `shadow: {color,blur,x,y}`,
`feather`. Animate `cornerRadius`, `strokeWidth`, `shadowBlur` continuously and
`shapeFill`/`stroke` with step tracks. `space: "screen"` skips the camera.
Invisible shape layers can mask other layers; inverted alpha masks with `feather`
make soft spotlights. Existing rect-mask semantics are preserved.

Burn accepts ASS/SRT, requires explicit fontsDir, and isolates font discovery.
Soft accepts SRT/VTT and produces mov_text. Subtitle paths are staged under safe
names before building filters. Style fields are `font`, `size`, `outline`,
`margin`, `position` 1–9, `direction` auto/rtl/ltr. Alignment is provider-neutral
SpeechTiming, with words or characters; the engine never generates narration.

Validation codes, with the existing issue path/severity/message format:
`VIDEO_NOT_PREPARED`, `VIDEO_HASH_MISMATCH`, `MISSING_VIDEO_FILE`,
`SOURCE_TIME_OUT_OF_RANGE` (warning), `CONFLICTING_CONTENT`, `INVALID_SHAPE`,
`INVALID_PATH_DATA`, `INVALID_AUDIO_RANGE`, `MISSING_SUBTITLE_FILE`,
`SUBTITLE_SHAPING_UNAVAILABLE` (warning). See the root README for operation errors,
compatibility details, limits, and the library API.

`render_video_start.videoCacheBytes` limits the per-asset frame cache in bytes (default 32 MiB, per worker when chunked). Partial ranges preserve scene-relative subtitle/audio timing. Audio extensions and subtitles also work with 3D output; `chunks > 1` currently requires a 2D scene. Set `VIDEO_ENGINE_FONTS_DIR` to run the shaping probe at startup and in `engine_capabilities`; individual subtitle renders still require explicit `fontsDir`.
