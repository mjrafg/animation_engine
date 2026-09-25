# Engine changes made for MCP control, and why

Every behaviour the MCP server exposes is implemented in the core engine (`src/`) and usable
without MCP. The server (`mcp/`) only validates arguments with the core schemas, calls the core
and formats results. Each change below was driven by a concrete need of agent control.

| Change (core) | Where | Why it was needed |
|---|---|---|
| **Video workspace** (`WorkspaceManager`, `VideoWorkspace`) | `src/workspace/workspace.ts` | Agents must work with stable ids (workspace, asset, scene, artifact) instead of host paths. They must persist scenes between calls, reuse one asset in many layers and scenes without copying, and get validated, atomic scene writes. Before this, the engine only rendered a scene file someone had written by hand. |
| **Path isolation** | `src/workspace/paths.ts` | Rejects absolute paths, `..` escapes, NUL bytes and symlinks leaving the root. Workspace ids are validated, and a server can be locked to one assigned workspace. |
| **Non-destructive asset derivation with provenance** | `VideoWorkspace.processAsset/trimAsset/removeAssetComponents` | Background removal, trim and component removal already existed as file-to-file functions. Agents needed them as asset → new asset operations that record source and options and never overwrite. |
| **`inspectImage`** | `src/assets/pipeline.ts` | Diagnose an image (alpha statistics, border background, visible bounds, suggested path) without processing it, so an agent can choose between trim, colour-key removal and using it as is. |
| **Batch timeline operations** (`applyTimelineOps`, shared `TimelineOpSchema`) | `src/api/operations.ts` | One atomic call for many keyframes, including camera, instead of one call per key. A failure names the operation (`opIndex`) and leaves the scene unchanged. The same schema validates MCP input. |
| **`addLayers` batch, `removeTrack`, `setAudio`** | `src/api/operations.ts` | Adding a whole rig in one validated step, where a child may precede its parent; removing a track; scene audio by asset id. |
| **Render jobs** (`RenderJobs`) | `src/workspace/jobs.ts` | Tandem gives each MCP call 60 s, and long renders take longer. Jobs run in the background with persisted progress, long-poll waits, cancellation, and interruption detection when a server process dies. |
| **Render cancellation** | `src/render/video.ts` (`abort`), `AnimationEngine.renderVideo({signal})` | Cancelling kills FFmpeg and deletes the partial file. FFmpeg and renderer failures now carry `FFMPEG_FAILED` / `RENDER_FAILED`. |
| **Stable error model** (`EngineError`, `errorFromIssues`) | `src/errors.ts` | Validator issue codes map to request-level codes (`INVALID_PARENT`, `PARENT_CYCLE`, `INVALID_KEYFRAME`, `LAYER_NOT_FOUND`, …) with every issue and its JSON path in `details`. `INVALID_FRAME` replaced `RangeError`. |
| **Capability discovery** | `src/capabilities.ts` | `engine_capabilities` is derived from the engine's own tables (animatable properties and their interpolation rules, interpolation list, mask union, timeline op union, processing functions), so it cannot drift from what the engine does. |
| **`measureLayout(frame, {layers})`** | `src/api/engine.ts` | Measure only the layers of interest; unknown ids → `LAYER_NOT_FOUND`. |
| **Agent-readable schema descriptions** | `src/scene/schema.ts` | Layer, keyframe and camera fields now carry `.describe()` text: pivot semantics, anchor, global z versus parent, frame numbering. Tool schemas and `schema/scene.schema.json` inherit it, so an agent can use the engine from the schemas alone. |
| **View images** (`makeViewImage`) | `src/workspace/workspace.ts` | Tandem's MCP client drops image content, and its Read guard refuses images over 150 KB. Every preview, frame, video poster and asset therefore gets a ≤ 960 px, ≤ ~140 KB JPEG (checkerboard behind transparency) that the agent opens by `viewPath`. |

## Bugs found and fixed during this phase (with regression tests)

- **Stale engine cache after asset file changes.** Found by the MCP render-failure test. The workspace cached a prepared engine keyed only by the scene document, so a deleted asset file still rendered from bytes held in memory instead of reporting `ASSET_NOT_FOUND`. The cache key now includes each referenced file's size and mtime, or "missing". Tests: `tests/workspace.test.ts` (engine cache), `tests/mcp/mcp.test.ts`.
- **Layer operations rejected assets being added in the same call.** Operation-level validation ran before the workspace synced the scene's asset map. The workspace now exposes all of its image assets while the operation runs, then prunes the map to the referenced ids.

## Results

Test totals:

- **Core (`npm test`):** 83 tests. This covers the original 70 engine tests plus 13 workspace/job tests.
- **MCP over real stdio (`npm run test:mcp`):** 10 tests, using a client that mirrors Tandem's `StdioConn`.

The Tandem end-to-end run is documented in [`tandem-e2e/REPORT.md`](tandem-e2e/REPORT.md).
