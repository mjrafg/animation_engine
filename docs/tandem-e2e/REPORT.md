# Tandem × Video Engine MCP — end-to-end test report

A Tandem **Builder** agent (Claude Code CLI, spawned by Tandem) drove the video engine
**only through the `video_engine_*` MCP tools**, which Tandem served through its own Integrations
gateway (`tandem_ext`). The agent built, inspected, corrected and rendered real videos.

Tandem's timeline for the run recorded:

- **72 tool calls, all `video_engine_*` MCP tools**, of which 7 were deliberately invalid.
- **0 shell commands and 0 file edits.**
- **12 file reads**, all of them the `viewPath` preview/asset JPEGs the tools returned.

## Setup

Tandem ran from the `mjrafg/tandem` checkout (v0.2.0, `npm run build`, `node server/dist/index.js`)
with its own isolated `DATA_DIR`/`PROJECTS_DIR`. The Builder was Claude Code CLI 2.1.282 with
model `claude-opus-5`.

- **Engine side:** built with `npm run build:mcp`; `dist/video-engine-mcp.mjs --self-test` → `healthy`.
- **Registration:** created with Tandem's own API through `integrations/tandem/register.mjs`, as an MCP Integration using transport `stdio`, command `node dist/video-engine-mcp.mjs`, and env `VIDEO_ENGINE_ROOT` plus `VIDEO_ENGINE_LIBRARIES=kitchen=<repo>/examples/kitchen/assets/originals`. The script printed:
  ```
  Created integration Video Engine (slug video_engine, id e0a2c939-…)
  Connection test: OK — Connected — the server reports 35 tools.
  Discovered 35 tools: video_engine_artifact_list, video_engine_asset_component_remove, …
  ```
  Tandem spawned the server itself. From there, discovery, calls, timeouts and idle handling were all Tandem's.
- **Reviewer disabled:** the Builder's reviewer (Codex) was turned off with `roles.builder_reviewer.enabled=false`, because the Codex CLI isn't installed in this container. The test targets the Builder operating the engine.
- **Two workarounds for this container**, not needed in a production deployment:
  - Tandem was started with `IS_SANDBOX=1`, because Claude Code refuses `bypassPermissions` as root. Tandem's production unit runs as a non-root service user.
  - The harness's own `CLAUDE_CODE_SESSION_ID`, messaging socket and related variables were removed from Tandem's environment, so the Builder CLI got its own session instead of attaching to the outer one.
- **Prompts:** the Builder received two chat messages in plain language: the task, plus "use only video_engine_* tools, no scripts, no ffmpeg, no source, open viewPath to look". The full text is in `tandem-chat-export.md`.

## What the agent did (Tandem timeline)

| Phase | MCP calls (from Tandem `tool_call` events) |
|---|---|
| Discover | `engine_capabilities`, `library_list` |
| Workspace + assets | `workspace_create`, `asset_import` ×8 (library), `asset_inspect` ×2, `asset_process` ×3, `asset_trim` ×5 |
| Scene | `scene_create`, `layer_add` (9-layer hierarchy in one call), `scene_get`, `timeline_apply` ×2 (one atomic batch, then one corrective `track.set` batch) |
| Check | `measure_layout` ×4, `render_preview` ×4 (one `debug=true`), plus Read of each `viewPath` |
| Correct | `layer_update` (atomic 2-layer patch), `measure_layout`, `render_preview`, Read |
| Render | `render_video_start`, `render_video_status` (long-poll → completed) |
| Reuse / errors / long render | `layer_add`, `scene_create` ×2, `asset_list`, `scene_get`, `layer_update` ×7, `timeline_apply` ×3, `measure_layout` ×2, `engine_health`, `render_video_start` ×3, `render_video_status` ×6, `render_video_cancel`, `artifact_list` |

Per-call status, duration and error code are in `tool-calls.json`. The server's own per-call log
is `mcp-server-log.jsonl`, and Tandem's full export (prompts, answers, tool rows) is
`tandem-chat-export.md`.

### Highlights from the agent's own report

- **Asset processing:** it detected the counter's key colour as `#23c43a` and the cup's as `#14a9e7`. The first cup pass reported 2 enclosed holes and a stray component. The agent read the diagnostics and saw that hole 1 is the **blue stripe on the mug** (keep it) and hole 2 is the **handle interior** (remove it). It re-processed with `removeHoles:[2]` + `removeComponents:[2]`, confirmed the result visually, then trimmed the 5 character parts.
- **Numeric correction before any render:** `measure_layout` showed the hand at world x≈238 instead of near the cup (x≈800). It worked out that with y pointing down, a positive (clockwise) rotation swings a hanging arm left. It re-applied the arm animation with negative angles, putting the wrist at (751, 453).
- **Visual correction:** the preview at frame 100 showed the hand covering the mug. One atomic `layer_update` changed:

  | property | before | after | reason |
  |---|---|---|---|
  | `cup.x` | 800 | 872 | the hand overlapped about 60% of the mug |
  | `cup.y` | 500 | 516 | seat the cup mid-surface on the counter top |
  | `head.width`/`height` | 157×200 | 122×155 | the head was out of proportion to the torso |

  It re-rendered and confirmed the fix visually.
- **Global z against hierarchy:** the debug preview shows `torso z=10 ^char_root`, `upper_arm z=11 ^torso`, `forearm z=30 ^upper_arm`, `hand z=31 ^forearm`, `counter z=20`. The torso draws behind the counter while its descendant forearm and hand draw above it.
- **Reuse:** `cup2` in the first scene and `cupA`/`cupB` in `reuse_check` use the same `cup` asset id, and the new scene reuses `kitchen_bg`, `counter` and `cup`. `asset_list` still showed 16 assets and nothing was imported again. `assetsUsed` matched.
- **Error recovery:** the agent read each error, corrected its call, confirmed `engine_health` was still OK, and confirmed with `scene_get` that no failed call had changed the scene.

  | Deliberately invalid call | Error code |
  |---|---|
  | `layer_update` on an unknown scene | `SCENE_NOT_FOUND` (with `available` scene ids) |
  | unknown layer | `LAYER_NOT_FOUND` |
  | unknown parent | `INVALID_PARENT` |
  | two-layer cycle | `PARENT_CYCLE` (`cupA -> cupB -> cupA`) |
  | `visible` with `linear` interpolation | `INVALID_KEYFRAME` |
  | `measure_layout` at frame 120 of a 60-frame scene | `INVALID_FRAME` |
- **Long render (30 s, 1920×1080, 900 frames):** status polls read 22/900 (2%), 121/900 (13%) and 152/900 (17%). A `waitSeconds:45` long-poll then returned `completed` after 33 s: artifact `video_2`, `renders/long_render_video_2.mp4`, `durationSeconds: 30`.
  - Invalid range `endFrame:1200` → `INVALID_FRAME`, and no job was created.
  - A second render was cancelled mid-run → `cancelled`, `RENDER_CANCELLED` at frame 103/900, and its partial file was removed.

## Evidence in this folder

| File | What |
|---|---|
| `videos/kitchen_shot_video_1.mp4` | the agent's final MP4: 1280×720, 30 fps, 4.0 s |
| `videos/long_render_video_2.mp4` | long-render job output: 1920×1080, 30 fps, 30 s |
| `images/preview1_before_fix_f100.jpg` → `images/preview3_after_fix_f100.jpg` (+ full PNG) | the preview the agent looked at, then the one after its numeric fix |
| `images/debug1_f60.jpg` | debug preview: bounds, ids, z, parents, pivots, attachment points |
| `images/asset_cup_source.png`, `asset_cup_v1_first_pass.jpg`, `asset_cup_final.jpg`, `asset_counter_processed.jpg` | colour-key background removal through MCP (source → first pass → final) |
| `images/preview4_reuse_check_f30.jpg`, `images/preview5_long_render_f450.jpg` | reuse scene and long-render scene previews |
| `images/video1_frames_grid.jpg`, `images/video2_frames_grid.jpg` | frames decoded from the final MP4s (every 20th / 180th frame) |
| `scenes/*.json` | the scene documents the agent created, exactly as stored by the engine |
| `tool-calls.json` | every Tandem `tool_call`: tool, status, duration, error code |
| `mcp-server-log.jsonl` | the MCP server's own JSONL call log |
| `tandem-chat-export.md` | Tandem's chat export: prompts, agent messages, tool rows. Checked: no secrets |

## Acceptance criteria

| Criterion | Result |
|---|---|
| Tandem launches/connects to the MCP server | ✅ Tandem connection test and every call spawned the server through its `StdioConn` |
| Tandem discovers the video tools | ✅ 35 tools discovered, served as `video_engine_*` |
| Agent inspects engine capabilities | ✅ `engine_capabilities` was the first call |
| Workspace isolation enforced | ✅ ids only, workspace-scoped; traversal, absolute paths and symlinks rejected (`tests/mcp`, `tests/workspace.test.ts`) |
| Assets referenced by stable ids | ✅ `asset: "cup"` in 5 layers across 3 scenes, one file |
| Create/modify scenes; manipulate layers | ✅ `scene_create`, `layer_add` batches, atomic multi-layer `layer_update` |
| Parent transforms through MCP | ✅ 5-level hierarchy; `measure_layout` world pivots follow the parents |
| Global z through MCP | ✅ torso behind the counter, forearm/hand above it (debug preview) |
| Keyframes and camera animation | ✅ atomic `timeline_apply` batches, including camera zoom/pan |
| `measure_layout` works | ✅ used to find and fix the rotation-sign error and the cup/hand overlap |
| Preview rendering; agent inspects the preview | ✅ 6 previews, each `viewPath` opened with Read |
| Agent corrects a scene after inspecting it | ✅ `cup.x/y`, `head.width/height` (before/after above) |
| Individual frame rendering | ✅ `render_frame` (MCP tests); the same path produces video frames |
| Final MP4 rendering | ✅ `video_1` (4 s) and `video_2` (30 s) |
| Asset processing | ✅ `asset_inspect`, `asset_process` (flood-fill key removal with hole and component control), `asset_trim` |
| Machine-readable errors | ✅ 7 distinct stable codes in the Tandem run; 20+ covered in tests |
| Invalid requests don't destabilise the server | ✅ `engine_health` OK afterwards; malformed JSON and unknown methods tested |
| Linux headless execution | ✅ everything above ran headless on Linux x64 (Node 22, bundled FFmpeg, prebuilt Skia/sharp) |
| Demonstration from inside Tandem via MCP, no engine imports | ✅ 0 shell commands, 0 file edits, 0 engine source reads |

## Observations and remaining limitations

- **Images:** Tandem's MCP client replaces non-text content with `[image content omitted]`, so the server returns image locations (`viewPath`) rather than inline images. View JPEGs stay under Tandem's 150 KB Read guard, and the agent opened every one it needed.
- **Pool idle close:** Tandem closes a pooled MCP connection after 5 idle minutes, which terminates the server process. A render job still running at that moment is reported `interrupted`. Polling `render_video_status` keeps the connection alive; in this run the 30 s render completed while being polled.
- **Out-of-range keyframes:** a keyframe past the end of the scene is accepted with a `KEYFRAME_AFTER_END` warning rather than an error. The agent pointed this out. It is the engine's documented behaviour: values hold after the last key.
- **Composition caveat the agent flagged:** in `kitchen_shot` the forearm keeps `z=30` for the whole shot, so while the arm hangs at rest (frames 0–40) it draws over the cabinet fronts. This follows the test's z requirement; a bent resting pose, or a step z keyframe, would avoid it.
- **Tool names:** Tandem prefixes tools with the integration slug, so engine tools read `video_engine_engine_capabilities`. This is cosmetic; renaming the integration would change the prefix.
- **Reviewer:** the Codex Reviewer was not part of this run (not installed here). The integration's tools default to the `builder` role.
