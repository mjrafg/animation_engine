# Video compositing implementation report

Date: 2026-10-02. Package version: 1.1.0. Scene version: 1.

**Implementation delivered for independent review; the full Definition of done is not yet met.** Two 1080p proof videos were produced with real ElevenLabs narration. Exact provider alignment, automated acceptance results, regression hashes, subtitle reference-image comparisons, and a published Git tag/PR remain outstanding. No test, lint, standalone typecheck, or regression suite was run by the Builder.

## Starting point and compatibility assumptions

Work started from `main` at `b5d3b67cc70159e1600381aa59180c2c4787c17a` in the original repository. The current application workflow requires `tandem/1c98b557`, no merge into `feature/video-compositing`, and no push. That supersedes the brief's branch/PR instructions. No remote branch, tag, or PR was published. Changes and fixtures are left for the application's checkpoint workflow; per-feature commits were not created.

The required schema, validator, timeline, display list, transforms, assets, renderers, encoder, API, workspace, MCP, and existing tests were read before implementation. These assumptions needed changes:

| Existing assumption | Implementation |
| --- | --- |
| Asset catalog and `Renderer.loadAssets` receive static image bytes | Separate image/video loaded assets and a `VideoFrameSource` map; video pixels are requested per draw command |
| Timeline only resolves images and fills | Resolve shape fields and video `sourceTime`/`sourceFrame`, including asset animation |
| Every layer receives the camera transform | Optional per-layer screen space, including layout pivots and attachment points |
| Mask content is an image or rectangle | Shape/video draw sources share the mask path; hidden mask layers retain usable alpha |
| Audio always starts a whole file at a frame | Explicit source trims, offsets and fades before delay/mixing |
| Encoding requires no job-local files | Safe subtitle/font staging and isolated Fontconfig configuration |
| Workspace assets are images/audio/models; jobs only render scenes | Prepared video records, metadata, inbox preparation jobs, persisted results and cancellation |
| Cached workspace engines can serve all requests | Video jobs own independent engines so previews do not change a running job's decoder state |
| Package entry points reference TypeScript source | ESM and declarations in `dist/lib`, a stable exports surface, separately bundled MCP and chunk worker |

New fields are optional. Existing image/fill transform and drawing arithmetic remains in place. Existing tests and example reference files were not changed. That is a code-review observation, **not** evidence that existing pixel hashes are unchanged. The user's Builder/Reviewer division supersedes the brief's request for a baseline suite run and repeated checks after each feature.

## What was built

- CFR preparation uses `ffprobe-static` (or `FFPROBE_PATH`) for structured probes, H.264/yuv420p, a default 15-frame GOP, no audio, explicit scaling/cropping, exact output frame count, SHA-256 and FFmpeg build metadata. It refuses existing destinations and reports upscaling. Source bytes are never modified.
- Scene validation rejects missing/unprepared/changed videos. Loading additionally checks stream dimensions, rates, frame count, pixel format, duration metadata and absence of audio. Prepared bytes are checked again when configuring a render and for subsequent random previews.
- `sourceTime` uses existing interpolation. Selection is `floor(time * fps + 1e-6)` with clamping. Validation reports affected inclusive scene-frame ranges. Layout reports resolved source time and frame. Multiple layers can sample different moments of one asset.
- Sequential and random frame sources use FFmpeg, bounded LRU storage, serialized reads, explicit close/abort handling, and backend-neutral RGBA. Random reads decode one frame; sequential reads keep a process alive. Cache limit defaults to 32 MiB per asset, configurable through library and render tools.
- Rectangles, rounded rectangles, ellipses and validated SVG paths render as vector geometry under the complete transform. Stroke alignment, shadows, animated corner radius/stroke width/shadow blur and discrete colors are supported.
- Shape alpha participates in existing layer masks, including invisible mask layers. `shape.feather` blurs the alpha edge. The inverted spotlight recipe and screen-space dim layer are documented.
- Audio extensions use `atrim`, `asetpts`, `afade`, millisecond placement and existing unnormalized mixing. Clips overlapping the beginning of a partial render are retained. Transactional add/update/remove audio tools are available in both APIs.
- Subtitle burn-in accepts ASS/SRT; soft MP4 tracks accept SRT/VTT. Paths and explicit fonts are copied under generated safe names; user path strings never enter filter graphs. Partial renders preserve scene-relative subtitle timing. Audio extensions and subtitle encoding also apply to 3D output.
- `subtitlesFromTiming` is a pure provider-neutral cue builder using existing `SpeechTiming`, deterministic line limits, punctuation/pauses, trim/offset mapping, RTL embedding, Korean word boundaries and explicit ASS styles. Tools write both ASS and SRT.
- Capability reporting records FFmpeg, H.264 decoder availability, libass burn and an actual Persian/Korean shaping probe when explicit fonts are available. MCP performs a startup probe using `VIDEO_ENGINE_FONTS_DIR` when set.
- Chunk workers render independent lossless FFV1/BGRA ranges, concatenate with stream copy, then run one final H.264 encode with audio/subtitles. This avoids separate lossy GOPs at boundaries. Pixel equivalence is an intended property covered by a test, not a verified result yet.
- The library exposes `AnimationEngine`, `EngineSession`, validation/schema/types, preparation, subtitles, capabilities, speech timing and tool definitions. Native/binary packages remain dependencies. Git dependency installation runs `prepare`; a Git tag still needs to be created after review.

README and `mcp/README.md` document the new fields, tools, examples, cache controls, environment variables and issue codes. Existing MCP naming (`layer_add`, `layer_update`, `render_video_start`, `engine_capabilities`) is preserved; session API names remain `add_layer`, `update_layer`, `render_video`, `capabilities`.

## Decisions and deviations

1. **Exact index decoding instead of timestamp seeking:** decoder restarts use `select=gte(n,index)` from frame zero. This avoids timestamp/keyframe rounding ambiguities, but large backward/forward jumps can be expensive. Sequential reads restart for backward jumps or jumps beyond 60 frames. Frame-accuracy tests remain to be run.
2. **Lossless chunks plus one final encode:** direct concatenation of independently encoded H.264 chunks can change quantization/GOP content. The extra intermediate uses more disk and CPU but is designed to preserve the pixels presented to the final encoder. Chunking currently supports 2D scenes only; 3D chunk requests fail explicitly.
3. **Legacy asset+fill compatibility:** image layers that previously accepted both still return `FILL_IGNORED`. New shape/video conflicts return `CONFLICTING_CONTENT`. Making every old image+fill scene invalid would violate backward compatibility.
4. **Feather is explicit:** `shape.feather` softens mask alpha independently of shadow color. Geometry is transformed before rasterization; feather is a screen-pixel blur. Mixed-space parenting inherits numeric parent transforms, while the child's `space` decides whether the camera applies.
5. **Partial audio rendering repaired:** previously tracks starting before a requested subrange were discarded. Overlapping clips are now cropped after their original fades. This intentional behavioral correction affects partial renders; ordinary full-scene legacy encoding arguments remain unchanged.
6. **ElevenLabs alignment fallback:** the connected creative tool produced real audio after credits were replenished, but exposes no with-timestamps endpoint. Its Scribe tool returned plain transcript/duration without alignment. No `ELEVENLABS_API_KEY` was available to the direct adapter. Fixtures explicitly mark timing as estimates, not provider alignment. This leaves the exact speech-timing acceptance item unmet.
7. **Korean duration:** the requested short Korean narration is 14.16 seconds, slightly below the approximate 15–20 second brief; Persian is 16.48 seconds. Both proof outputs are 20.2 seconds.
8. **Verification and Git workflow:** no baseline suite/example hashes or subsequent suite runs were performed. No push, PR, tag or per-feature commits were made under the active application workflow. Release and acceptance evidence remain with the Reviewer/Director.
9. **Cue edge cases:** impossible word length/duration limits are explicit errors; minimum cue duration yields to the next cue or trim boundary with a warning. ASS braces are removed and backslashes replaced with a full-width character to keep speech text literal rather than executable ASS overrides. This sanitization can change those literal characters.

## ElevenLabs fixtures and regeneration

Model: `eleven_v3`. Voice: Bella — Professional, Bright, Warm, ID `hpp4J3VqNfWAUOO0d1Us`. The model's Persian and Korean support was checked against [ElevenLabs model documentation](https://elevenlabs.io/docs/overview/models). The direct regeneration adapter targets the [with-timestamps endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).

Fixtures under `examples/footage-proof/fixtures` include the generated MP3s, transcripts/provenance, fallback `SpeechTiming`, and `.alignment.json` files explicitly stating that provider alignment is unavailable. Persian generation ID: `G6vJZPij3p60BGcPewxW`; Korean: `R74ZOqhMdbAyhAWYj7ub`. No API key is stored in source, fixtures, reports or logs.

The fallback uses detected sentence pauses and distributes word time proportionally to character count. It drives two narration trims, captions, and the click's approximate spoken-word timing. **Exact word synchronization is not claimed.** Sentence boundaries are obtained from the timing fixture; the engine contains no provider/application-specific logic.

`integrations/elevenlabs/timing.ts` converts character alignment to `SpeechTiming`. `regenerate.ts` explicitly requests audio plus timestamps using only `ELEVENLABS_API_KEY`, overwrites the fixtures, removes obsolete generation metadata, and is never called by builds, tests or proof re-renders. Regeneration requires renewed artifact production and review.

## Proof and measured performance

`examples/footage-proof/run.ts` generates a 2560×1440 synthetic source with visible pixel barcode and a seven-second static-content region (the barcode itself continues changing). Scene assembly, preparation, narration, captions and rendering use `EngineSession.call`. Fixture generation itself uses canvas/FFmpeg; no website or browser is involved. The proof uses the in-process tool layer, not a live MCP transport; MCP coverage is separately written for the Reviewer.

The source region from 6 to 13 seconds is compressed into 36 scene frames (1.2 seconds). Outputs are 1920×1080, 30 fps, 606 frames, H.264/AAC with burned subtitles. Overlays include a path cursor, ellipse click pulse, rounded highlight, feathered invisible mask hole, screen-space dim and fading still image. Camera keyframes zoom/pan with easing; each language uses two trimmed clips from one narration file.

Machine: Linux x64, 8 visible CPUs, AMD EPYC 9354P 32-Core Processor, Node v22.23.2. These are actual production render measurements, not benchmark-suite results:

| Output | Total seconds | Frames/second | Decode seconds | Draw seconds | Encoder write/backpressure seconds | Encoder finish seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Persian `out/fa.mp4` | 73.089 | 8.29 | 13.951 | 50.975 | 7.531 | 0.246 |
| Korean `out/ko.mp4` | 66.472 | 9.12 | 13.270 | 48.049 | 4.459 | 0.190 |

Drawing dominates, including large video uploads, transformed compositing and full-canvas soft-mask scratch surfaces. Encoder CPU runs concurrently; write/backpressure plus finish time is **not** total encoder CPU time. Preparation and source generation are excluded from render timings. No parallel-worker speed was measured. Timings, full build details and SHA-256 values are preserved in `docs/video-compositing-evidence.json`.

Produced files include both MP4s, `out/tool-calls.json`, `out/results.json`, subtitle files, prepared metadata, and generated scene documents. The downloadable proof archive contains these outputs and offline narration/font fixtures. Generated outputs are ignored by Git; source fixture files are included in the pending code change.

The videos were produced before final fixes to partial-range timing, cancellation, metadata checks, and packaging. They were not repeatedly rendered for verification. They do not demonstrate chunk equivalence or the newly repaired partial-range paths.

## FFmpeg and subtitle shaping

The actual proof used `FFMPEG_PATH=/usr/bin/ffmpeg` and `FFPROBE_PATH=/usr/bin/ffprobe`. Build: `ffmpeg version 6.1.1-3ubuntu5`, gcc 13 / Ubuntu 13.2.0-23ubuntu3. Relevant runtime output:

```text
libass source: tarball: 0.17.1
Raster: FreeType 2.13.2
Shaper: FriBidi 1.0.13 (SIMPLE) HarfBuzz-ng 8.3.0 (COMPLEX)
```

Noto Sans Arabic and Noto Sans KR font files and their OFL licenses are supplied explicitly in the proof. The isolated probe renders known Persian and Korean strings. Its corrected result is `subtitles.burn: true`, `subtitles.complexShaping: true`.

The original proof run recorded a false missing-shaping warning because the first classifier mistook libass's successful fallback to the Korean font for a missing glyph. That classifier was corrected to detect failed fallback. One focused diagnostic rerun returned the result above. Original measurement records were preserved rather than rewritten. This diagnostic establishes runtime library/glyph availability; native-language visual review and reference-image comparisons are still pending.

The bundled `ffmpeg-static` binary was not characterized: dependency installation disabled lifecycle scripts and this environment already supplied a suitable system build. Use `FFMPEG_PATH` with a libass/FriBidi/HarfBuzz build when the bundled build is insufficient. Set `VIDEO_ENGINE_FONTS_DIR` for the startup probe; a burn render independently requires `fontsDir`.

## Packaging and verification handoff

The actual artifact build (`npm run build`) completed successfully and emitted ESM/declarations, MCP and the chunk worker. Its first attempt failed on one worker error-handler `unknown` type; that was repaired before completing the build. The build was run to produce the downloadable package, under the packaging exception. A subsequent `npm pack --ignore-scripts` unexpectedly invoked preparation again and exited 226 without a detailed error in silent mode. To avoid repeating lifecycle builds, the downloadable `.tgz` was assembled directly from the declared package files under the standard `package/` archive prefix. Its installation has not been exercised. `npm test`, `npm run test:mcp`, `npm run typecheck`, lint, regression sweeps, screenshot matrices and Git-tag installation were **not run**.

New tests, not executed here:

- `tests/compositing.test.ts`: preparation/hash validation; barcode source selection, timeline retiming, random/sequential/chunk output; repeatability; cancellation; shape stroke alignment/antialiasing/animation; spotlight and screen space; new validation cases; Persian/Korean cue strings; safe staging; partial-range soft subtitles; transactional audio and shaping capability diagnostics.
- `tests/compositing-audio.test.ts`: known tone correlation within ±1 ms, trims/fades and full/partial render placement.
- `tests/mcp/compositing.test.ts`: preparation job, video/shape layer editing, measurement/render, caption files and workspace path rejection through the real MCP transport.

Reviewer environment: Node 20+ (Node 22 used here), installed native dependencies, FFmpeg/ffprobe, supplied proof fonts; Blender is required for existing 3D regressions. Prioritize zero barcode mismatches including source-mode worker startup, decoded chunk equivalence, aborted/error/cancelled decoder PIDs, stroke clipping, audio correlation, negative-offset soft subtitles, 3D encode extensions, and all legacy hashes. Subtitle image goldens and OS-level orphan-process assertions remain acceptance-evidence gaps beyond the current tests.

Library consumers should serialize operations on each engine instance and close video sources when finished. Sequential renders assume prepared files remain immutable for the render's lifetime. Total memory includes scratch canvases, transient frames and decoder buffers in addition to the configured cache; chunk workers multiply per-worker costs. Full-frame warning evaluation scales with scene duration and layer count. Audio/video probing is synchronous and bounded by timeout, so cancellation waits for an in-progress probe.

## Definition of done status

Checkmarks below indicate implementation/artifacts observed, not an unrun acceptance check.

- [x] CFR preparation, metadata/hash rejection implemented; proof source prepared.
- [ ] Zero frame-accuracy mismatches in all modes: tests written, Reviewer must execute.
- [ ] Shape crispness/antialiasing: implementation and targeted tests present; verification pending.
- [ ] Animated soft spotlight: present in proof/tests; visual acceptance pending.
- [x] Screen-space layer implementation and documented recipe.
- [x] Audio trim/offset/fades and MCP editing implemented; timing accuracy awaits tests.
- [x] Persian/Korean burn capability probe reports concrete runtime shaping support; proof outputs produced.
- [ ] Correct Persian/Korean cue/image acceptance: deterministic files generated; reference comparison pending.
- [ ] Exact ElevenLabs audio plus provider alignment fixtures: audio present, alignment unavailable; labeled fallback supplied.
- [ ] Installation from a Git tag: library package built, no release tag published or installation verified.
- [x] New features exposed through session tools and MCP definitions; transport tests await Reviewer.
- [ ] All existing tests and example hashes unchanged: not run.
- [x] Proof outputs produced through session tool calls with measured render speed and this report.
- [ ] Feature branch and PR: superseded by active Tandem branch/no-push policy; Director must resolve release workflow.
- [x] README and MCP documentation added.

The Director must resolve the exact-alignment and release-workflow deviations. This report does not declare the original acceptance checklist complete.
