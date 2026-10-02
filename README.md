# Deterministic Layered 2D (+ 3D) Animation Engine

A deliberately simple, **non-intelligent** 2D renderer. It executes an explicit scene
description exactly: positions, pivots, z values, keyframes, camera. All decisions about *what*
the scene should contain are left to whoever writes the JSON (later, an AI agent).

```text
AI agent (later) ──► Scene JSON ──► validate ──► evaluate(frame) ──► resolve transforms
                                                                        │
          MP4 ◄── FFmpeg ◄── raw RGBA frames ◄── Renderer ◄── display list
```

* TypeScript on Node.js 22. CPU rendering with Skia (`@napi-rs/canvas`): no Chromium, no WebGL.
* Zod schema validation with machine-readable errors.
* `sharp` handles image I/O for the asset pipeline. FFmpeg (bundled `ffmpeg-static`, or `FFMPEG_PATH`) encodes H.264 + AAC.
* Proof of work: `examples/kitchen/out/kitchen.mp4` (11 s, 1920×1080, 30 fps, with audio).
  See [docs/REPORT.md](docs/REPORT.md) for what was inspected, the problems found and fixed, and
  the remaining limitations.

## 3D scenes (hybrid 2D + 3D)

Besides 2D scenes, the engine makes **3D scenes**:

- GLB characters, props and environments, including rigged characters with clips, crossfades, bone sockets and props attached to hands;
- face morph targets, a 3D camera and lights, all on the same timeline;
- numeric 3D inspection, previews and MP4 with audio;
- optional 2D overlay scenes on top.

The engine owns the scene and the timeline. Headless **Blender** only draws the per-frame state it is given. 2D is unchanged.

- Design, research findings, Linux install (Blender, EGL), CPU/GPU behaviour, schema and tools: [`docs/3D.md`](docs/3D.md).
- Proof: `npm run example:3d` → [`examples/3d-proof/out/mika_3d.mp4`](examples/3d-proof/out).

## Prepared characters and high-level actions

A character is **prepared once**, as a package of rig or model, motions or clips, expressions, mouth shapes, eyes and sockets. After that, agents drive it with high-level actions (what, when, how long, where):

- walk or run left/right or to a position, idle, turn, look;
- talk (from provider-neutral speech timing, or generic), smile or other expressions, blink;
- gestures such as wave and point;
- props held at sockets.

Compatible actions combine: walk + talk, talk + smile + blink. Conflicts return structured errors. The runtime compiles the actions into ordinary layers/objects and timeline tracks, so rendering stays canonical and deterministic. It works the same for 2D (Pip) and 3D (Mika) characters.

- Details: [`docs/CHARACTERS.md`](docs/CHARACTERS.md).
- Proof: `npx tsx examples/characters-proof/run.ts` → `examples/characters-proof/out/pip_2d.mp4`, `mika_3d.mp4`.

## Multi-character interactions

Placed characters interact through reusable definitions: `handshake`, `high_five`, `hug`, `give_object` / `receive_object`, `push`, or custom ones registered as data (`interaction_define`). One call names the interaction, its actors, when it starts and how long it lasts:

```jsonc
{ "interaction": "handshake", "actors": ["anna", "ben"], "start": 11, "duration": 3 }
```

The runtime handles the choreography:

- aligns the actors face to face, using their own reach and size;
- walks the approaching actor into place and turns both to face each other;
- holds them there;
- drives their arms to the contact targets (2D and 3D two-bone IK);
- hands objects over, switching the attachment exactly once.

Everything compiles into the canonical timeline. Talking, expressions and blinking keep running on each character independently. Overlapping walks, turns or gestures are structured `ACTION_CONFLICT` errors that name the interaction.

- Details: [`docs/INTERACTIONS.md`](docs/INTERACTIONS.md).
- Measured proof, with the conversation scene, the 3D and 2D showcases and the different-size results: [`docs/interactions/REPORT.md`](docs/interactions/REPORT.md), produced by `npx tsx examples/interactions-proof/run.ts`.

## Agent control over MCP (Tandem)

The engine runs as an **MCP server** (`video-engine-mcp`, 54 tools: 2D, 3D, characters and interactions), so agents can control it
entirely through structured tool calls. They inspect capabilities, work in isolated workspaces,
process assets, build and animate scenes, measure layout, look at previews and render MP4s as
jobs. Tandem registers it as a standard MCP Integration.

- Server, tools, configuration, Linux dependencies and Tandem registration: [`mcp/README.md`](mcp/README.md).
- Engine additions this required, and why: [`docs/ENGINE_CHANGES_MCP.md`](docs/ENGINE_CHANGES_MCP.md).
- End-to-end run of a Tandem agent driving the engine through MCP only, with logs, previews and MP4s: [`docs/tandem-e2e/REPORT.md`](docs/tandem-e2e/REPORT.md).

```bash
npm ci && npm run build:mcp
node dist/video-engine-mcp.mjs --self-test --root /srv/video-workspaces
node integrations/tandem/register.mjs      # see mcp/README.md for the env it needs
```

## Quick start

```bash
npm install
npm test                       # core engine tests (npm run test:mcp: MCP server over stdio)
npm run typecheck

npm run example:all            # generate + process assets, build scene, feedback loop, render
npm run playground             # second example: two kids on a seesaw (examples/playground, 10 s MP4)
# or step by step:
npm run example:assets         # examples/kitchen/assets/{originals,processed}
npx tsx examples/kitchen/build-scene.ts
npm run example:feedback       # measure_layout-driven correction of scene data
npm run example:render         # previews, debug previews, layout JSON, MP4

# CLI (npm run ae -- <command> ...)
npx tsx src/cli.ts validate examples/kitchen/scene.json
npx tsx src/cli.ts preview  examples/kitchen/scene.json 155 out.png [--debug]
npx tsx src/cli.ts layout   examples/kitchen/scene.json 155 right_hand cup_in_hand
npx tsx src/cli.ts video    examples/kitchen/scene.json out.mp4 [--start 0 --end 90 --crf 18 --no-audio]
npx tsx src/cli.ts process  input.png outDir [options.json]
npx tsx src/cli.ts tools                                   # JSON-schema tool definitions
npx tsx src/cli.ts tool measure_layout '{"frame":155}' --scene examples/kitchen/scene.json
npx tsx src/cli.ts batch commands.json                      # [{ "tool": ..., "args": ... }, ...]
```

## Coordinate system

| | |
|---|---|
| Units | output-canvas pixels |
| Origin | `(0,0)` = top-left of the canvas; `(width,height)` = bottom-right; centre of 1920×1080 = `(960,540)` |
| Axes | +x right, **+y down** |
| Rotation | degrees; **positive = clockwise** on screen |
| Time | integer frame numbers `0 … duration-1`; seconds = frame / fps. No clocks, no randomness |

**World space** is the scene before the camera. **Screen space** is the output canvas after the
camera. With the default camera the two are identical.

## Layers

Everything visible is a layer. A layer shows an image asset (`asset`), a solid rectangle (`fill`),
or nothing: a layer with neither is a pure transform node, e.g. a character root.

```jsonc
{
  "id": "counter",               // unique; "camera" is reserved
  "asset": "counter_keyed",      // key in scene.assets (or omit / "fill": "#rrggbb")
  "parent": null,                // transform parent (layer id)
  "parentPoint": null,           // optional: attach to a named attachment point of the parent
  "x": 1250, "y": 1000,          // position of the PIVOT, in the parent's pivot space
  "width": 1248, "height": 426,  // base box size before scale (default: the asset's pixel size)
  "anchorX": 0.5, "anchorY": 1,  // where the pivot is inside the box: 0,0 top-left … 1,1 bottom-right
  "scaleX": 0.85, "scaleY": 0.85,// rendered size = width·scaleX × height·scaleY (negative = mirror)
  "rotation": 0,                 // degrees clockwise, around the pivot
  "opacity": 1,                  // 0..1, multiplied by ancestors' opacity
  "visible": true,               // false hides this layer and its descendants
  "z": 20,                       // GLOBAL render order
  "mask": null,                  // optional, see Masks
  "attachmentPoints": {}         // optional, merged over the asset's points
}
```

### How x, y, anchor, width, height, scale and rotation interact

For a layer with box `w×h` and anchor `(ax, ay)`:

1. The pivot is the point `(ax·w, ay·h)` of the box. In the box's own pixels, `(0,0)` is the image's top-left corner.
2. Scale is applied about the pivot, then rotation about the pivot.
3. The pivot is placed at `(x, y)` of the parent's pivot space. For a root layer that is world space.

As matrices (canvas convention, `M·p`):

```text
local = T(x, y) · R(rotation) · S(scaleX, scaleY)          pivot space -> parent pivot space
        (preceded by T(parentPoint offset) when parentPoint is set)
world = parent.world · local                               pivot space -> world
box   = world · T(-ax·w, -ay·h)                            box pixels  -> world
screen= camera · box                                       box pixels  -> canvas
```

Consequences worth knowing:
* Changing `rotation` or `scale` never moves the pivot. Changing the anchor moves the image around a fixed pivot.
* A child's `x/y` is measured from the parent's **pivot**, along the parent's rotated and scaled axes. A forearm at `x:0, y:140` under an upper arm pivoted at the shoulder sits 140 px down the arm, however the arm is rotated.
* A parent's scale scales the child's offset **and** its size.

## Transform hierarchy vs. global z-order

These are **separate concepts**.

* `parent` controls **transform inheritance only** (position, rotation, scale), plus opacity and visibility.
* `z` controls the **global draw order** across the whole scene. The engine sorts all drawable
  layers by `z` ascending; ties keep document order. There is no per-parent render group, so a
  child can draw below its parent, above unrelated layers, or anywhere in between.

The kitchen scene uses exactly this:

```text
background z=0 · legs z=5 · torso z=10 · head z=11 · upper arms z=13 · counter z=20
right_forearm z=30 · cups z=30.5 · right_hand z=31 · steam z=33 · plant z=50 · fade z=100
```

`right_forearm → right_upper_arm → torso → character` is a single transform chain, yet the torso
draws behind the counter and the forearm draws in front of it. `z` is also animatable with step
keyframes. The forearm uses `z: 14` while walking and switches to `30` at frame 125, when it
reaches over the counter.

## Attachment points

Named points on an asset or layer, in **normalised coordinates of the layer box**: `(0,0)` is the
top-left corner of the image, `(1,1)` the bottom-right. Values outside `[0,1]` are allowed. They
follow the layer's full transform, so `measure_layout` reports each one in world and screen space:

```json
"assets": { "right_hand": { "src": "…/processed-transparent.png",
                            "attachmentPoints": { "wrist": {"x":0.4264,"y":0.0385}, "grip": {"x":0.4264,"y":0.6154} } } }
```

`parentPoint` places a child's origin at one of its parent's points. For example, the cup in the
hand uses `"parent": "right_hand", "parentPoint": "grip"`, with its own anchor set to the cup's
`handle` point. The asset pipeline converts points given in original pixels
(`attachmentPointsPx`) into this normalised form, taking the trim offset into account.

## Masks

```jsonc
"mask": { "type": "rect", "x": 470, "y": 120, "width": 520, "height": 330, "space": "world" } // or "layer"
"mask": { "type": "layer", "layer": "window_mask", "invert": false }
```

A `rect` mask is an axis-aligned rectangle, either in world space (the camera still applies) or in
this layer's own box pixels. A `layer` mask uses another layer's alpha at that layer's world
transform. The mask layer's `visible` flag does not affect masking, so set `visible:false` on
layers that exist only as masks. In the kitchen scene, the sky uses a rect mask and the cloud uses
a layer mask.

## Camera

```json
"camera": { "x": 0, "y": 0, "scale": 1, "rotation": 0 }
```

`x/y` pan in world pixels: the view centre looks at world point `(W/2 + x, H/2 + y)`. `scale`
zooms about the view centre and must be > 0. `rotation` rolls the camera clockwise, so the scene
appears to turn counter-clockwise. The camera is one root transform applied after the scene. Layer
definitions never change when the camera moves. All four properties are animatable through
`"target": "camera"`.

## Timeline and keyframes

```json
{ "target": "character", "property": "x",
  "keyframes": [ { "frame": 0, "value": -150, "interpolation": "linear" },
                 { "frame": 84, "value": 1060, "interpolation": "ease-out" },
                 { "frame": 100, "value": 1150 } ] }
```

* A track overrides the static value for that `(target, property)` at every frame. There is at most one track per pair.
* A keyframe's `interpolation` applies to the segment **from that keyframe to the next**:
  `step`, `linear`, `ease-in`, `ease-out`, `ease-in-out`, and `cubic-bezier` with `"bezier": [x1,y1,x2,y2]` (CSS semantics).
* Before the first keyframe the first value holds. After the last keyframe the last value holds.
  With `step`, the value switches exactly on the next keyframe's frame.
* **Continuous** properties: `x y width height scaleX scaleY anchorX anchorY rotation opacity`, and
  camera `x y scale rotation`. Bounded values are clamped after easing.
* **Discrete** properties: `asset visible z fill`. These must use `step`, which is also the default.
  Mouth shapes, blinking and hand-offs all use this single generic mechanism:

```json
{ "target": "mouth", "property": "asset",
  "keyframes": [ {"frame":0,"value":"mouth_rest"}, {"frame":210,"value":"mouth_A"}, {"frame":214,"value":"mouth_MBP"} ] }
```

When a layer has no explicit `width`/`height`, its size follows the current asset's natural size.
The mouth layer relies on this, together with `scale: 0.5` because its assets are 2× resolution.

## Audio

```json
"audio": [ { "src": "assets/audio/voice.wav", "startFrame": 0, "volume": 0.8 } ]
```

FFmpeg delays each track to `startFrame / fps`, mixes the tracks, encodes AAC and cuts the result
to the video length.

## Validation

`validateScene(json, { baseDir })` never throws. It returns `{ ok, scene?, errors[], warnings[] }`.
Each issue has a stable `code`, a JSON `path` into the document, a `message`, and optional
`details`. For example:

```json
{ "severity": "error", "code": "PARENT_CYCLE", "path": ["layers", 2, "parent"],
  "message": "Parent cycle: a -> c -> b -> a", "details": { "cycle": ["a","c","b"] } }
```

Codes include `DUPLICATE_LAYER_ID`, `MISSING_ASSET`, `MISSING_ASSET_FILE`, `INVALID_TYPE` (NaN,
Infinity, wrong type), `VALUE_TOO_SMALL` / `VALUE_TOO_BIG` (negative sizes, anchors outside 0..1,
opacity, camera scale ≤ 0, negative frames), `UNKNOWN_PROPERTY` (typos), `MISSING_PARENT`,
`PARENT_CYCLE`, `MISSING_ATTACHMENT_POINT`, `MISSING_TARGET`, `UNSUPPORTED_PROPERTY`,
`INVALID_INTERPOLATION`, `MISSING_BEZIER`, `DUPLICATE_KEYFRAME`, `DUPLICATE_TRACK`,
`INVALID_KEYFRAME_VALUE`, `INVALID_MASK` and `RESERVED_LAYER_ID`. A generated JSON Schema lives in
[`schema/scene.schema.json`](schema/scene.schema.json) (`npm run schema`).

## Asset processing

```ts
import { processAsset } from "./src/assets/pipeline.js";
const meta = await processAsset("cup.png", "processed/cup", {
  detect:  { borderSampleSize: 12, uniformityTolerance: 12, minUniformity: 0.9 },
  removal: { colorTolerance: 18, edgeSoftness: 3, despill: true, removeHoles: [2] },
  trim:    { alphaThreshold: 4, padding: 2 },
  removeComponents: [2],
  attachmentPointsPx: { handle: { x: 330, y: 205 } },
});
```

* **Path A: native alpha.** Chosen automatically when at least half the border is transparent. The
  pipeline validates the alpha (transparent, partial and opaque fractions; subject touching an
  edge; hard edges) and trims. It never colour-keys this path.
* **Path B: solid key colour.**
  1. **Detect** the background from the outer border band, with no assumed colour. Uses a coarse Lab histogram mode,
     then the per-channel median of the inliers. It reports `borderUniformity`, `sideUniformity`, `sideColorSpread`
     (gradients), `noise` and `confidence = min(uniformity, worst side) · (1 − spread/tolerance)`. If
     uniformity < `minUniformity`, processing stops with `BORDER_NOT_UNIFORM`, unless `force` is set.
  2. **Edge-connected flood fill** (4-connected, CIE76 ΔE in Lab). It is seeded only from border
     pixels, so only background connected to the outside is removed. Enclosed key-coloured regions
     are kept and reported as `holes` with ids, bounds and centroids. A caller removes a hole only
     by passing its id, or `"all"`.
  3. **Soft edges and despill.** For each pixel within `edgeSoftness` px of the removed region, the
     pipeline models the colour as `C = a·F + (1−a)·B`. `F` is the neighbouring colour that explains
     `C` with the least residual, preferring the purest candidate. It sets alpha `a`, then un-mixes the
     colour as `(C − (1−a)·B)/a`, which removes the key-colour fringe. A fallback along the key's chroma axis
     handles three-colour edges.
  4. **Components.** 8-connected components of the alpha mask get stable ids (1 = largest).
     Nothing is removed automatically; `removeComponents: [ids]` removes the chosen ones.
  5. **Trim** to the visible bounds, with a threshold and padding.
* **Non-destructive output:** `original.<ext>` (byte copy), `background-mask.png`,
  `untrimmed-transparent.png`, `processed-transparent.png`, and `asset-metadata.json`. The metadata
  holds the diagnostics, trim offsets, components, holes and attachment points. The source file is
  never modified.

## Previews, layout and rendering

```ts
const engine = await AnimationEngine.fromFile("scene.json");
await engine.prepare();                                  // validate + load assets
await engine.renderPreview(155, "p.png");               // normal PNG
await engine.renderDebugPreview(155, "d.png", { only: ["right_hand"], aabb: true });
engine.measureLayout(155);                               // numbers, see below
const frame = await engine.renderFrame(155);             // RGBA buffer / PNG
await engine.renderVideo("out.mp4", { crf: 18 });        // RGBA → FFmpeg stdin → H.264
```

The **debug preview** draws each layer's rotated bounds, id, `z` and parent, pivot cross, centre
dot, and attachment points, with a header showing the camera state. It is an overlay on the
preview only and never part of scene output.

**`measure_layout(frame)`** returns, per layer: `worldPivot`, `worldCenter`, `worldBounds` (AABB),
`worldCorners` (rotated box), the same four in `screen*`, `worldRotation`, `worldScale`, `z`,
`drawIndex`, effective `visible`/`opacity`, `onScreen`, `localMatrix`, `worldMatrix`, and
`attachmentPoints: { name: { world, screen, normalized } }`. It also returns the frame's
`drawOrder` and camera.

`renderVideo` streams straight RGBA frames into FFmpeg's stdin; no PNGs are written. PNG export
of single frames stays available for debugging.

**Determinism:** output depends only on the scene JSON, the asset bytes, the frame number and the
renderer build. Tests assert identical SHA-256 pixel hashes across renders and across engine
instances.

## Agent-facing tool API

`EngineSession.call(tool, args)` returns `{ ok: true, result, warnings? }` or
`{ ok: false, errors }`, with the same issue format as validation. Every tool takes and returns
plain JSON. `toolDefinitions()` emits JSON Schemas, ready for MCP or function calling.

| Scene | Layers & hierarchy | Timeline | Assets | Output |
|---|---|---|---|---|
| `create_scene` `load_scene` `save_scene` `get_scene` `validate_scene` `set_scene_props` `set_camera` | `add_layer` `update_layer` `remove_layer` `set_parent` `set_asset` `remove_asset` | `add_keyframe` `update_keyframe` `remove_keyframe` `set_track` | `process_asset_background` `trim_transparent` `find_components` `remove_component` | `render_preview` `render_debug_preview` `measure_layout` `render_frame` `render_video` |

Edits are transactional. Each one is applied to a copy, validated, and rejected if it introduces a
new error; for example, `set_parent` that would create a cycle returns `PARENT_CYCLE` and leaves
the scene unchanged. `examples/kitchen/feedback-loop.ts` uses only these tools: it measures,
edits keyframe values, re-measures and re-renders.

## Project layout

```text
src/
  math/matrix.ts          2D affine matrices
  scene/schema.ts         Zod scene schema, animatable property table
  scene/validate.ts       semantic validation (machine-readable issues)
  timeline/               easing (incl. cubic-bezier) + frame evaluation
  engine/transform.ts     local/world/box/camera matrices, render order
  engine/displayList.ts   backend-agnostic draw commands
  engine/layout.ts        measure_layout
  engine/debugOverlay.ts  debug overlay primitives
  engine/assets.ts        asset catalog (bytes + natural sizes)
  render/renderer.ts      Renderer interface (future PixiRenderer plugs in here)
  render/skia.ts          SkiaRenderer (@napi-rs/canvas)
  render/video.ts         FFmpeg pipe encoder (+ audio mux)
  assets/                 background detection, flood fill + despill, trim, components, pipeline
  api/engine.ts           AnimationEngine facade
  api/operations.ts       pure transactional scene edits
  api/tools.ts            agent tool layer (JSON in/out, JSON schemas)
  workspace/              ID-based workspaces, artifacts, render jobs
  characters/             character runtime: packages, actions -> plan -> compiled tracks, speech,
                          multi-character interactions (definitions, alignment, reach IK, transfers)
  scene3d/                3D: glTF inspection, Scene3D schema/validation/evaluation/operations,
                          Blender runner (blender.ts) + backend script (blender/engine3d.py)
  cli.ts
mcp/                      MCP server (thin adapter over the core)
assets/3d/                3D test assets (+ src/build_assets.py generator, third_party/fox)
assets/characters/        prepared test characters: pip (2D, + src/build-pip.ts), mika (3D), props
assets/interactions/      example custom interaction definition (professor_greeting.json)
tests/                    vitest suites (tests/mcp: MCP over stdio)
examples/kitchen/         test scene: generators, processed assets, scene.json, outputs
examples/3d-proof/        first 3D proof (run.ts) and its outputs
docs/REPORT.md            inspection report and limitations
```

## Video compositing (1.1)

The library is ESM with declarations at `dist/lib`. Install a release tag with
`npm install github:mjrafg/animation_engine#v1.1.0` once that tag has been released.
Git installs run `prepare` to build the library and MCP from the same sources.
Native canvas/sharp and FFmpeg/FFprobe remain external dependencies. Node 22.12+
is recommended for the repository's development tools. Scene version remains 1.
The stable root exports include `AnimationEngine`, `EngineSession`, scene types and
schemas, `validateScene`, `prepareVideoAsset`, `subtitlesFromTiming`, `TOOLS`, and
`toolDefinitions`. Public breaking changes require a major version.

Prepare arbitrary footage once, then register the returned asset:

```ts
import { EngineSession } from 'animation-engine';
const session = new EngineSession();
await session.call('create_scene', { baseDir: process.cwd(), duration: 300 });
const prepared = await session.call('prepare_video_asset', {
  input: 'input.mp4', outDir: 'assets/prepared', options: { fps: 30 }
});
if (!prepared.ok) throw new Error(JSON.stringify(prepared.errors));
await session.call('set_asset', { id: 'footage', asset: prepared.result.asset });
await session.call('add_layer', { layer: {
  id: 'footage', asset: 'footage', width: 1920, height: 1080,
  x: 960, y: 540, sourceTime: 0
}});
await session.call('set_track', {
  target: 'footage', property: 'sourceTime',
  keyframes: [{ frame: 0, value: 0 }, { frame: 299, value: 299 / 30 }]
});
```

`kind: "video"` requires `video: {width,height,fps,frameCount,duration,preparedBy,sha256}`.
Preparation writes `prepared.mp4` and `video-metadata.json`, uses CFR H.264/yuv420p,
removes audio, and records the FFmpeg build and prepared-file hash. `fps` defaults
to the session/scene fps (30 in the standalone function). Optional `width`, `height`,
`fit: "contain" | "cover"` and `gop` control scaling/cropping and keyframe interval.
Odd target dimensions are rejected; requested upscaling produces `VIDEO_UPSCALED`.
Existing outputs and overwriting the input are refused. `FFPROBE_PATH` overrides
`ffprobe-static`; `FFMPEG_PATH` overrides `ffmpeg-static`.

`sourceTime` is seconds, static zero by default, and supports every continuous
interpolation. Selection is `floor(sourceTime * fps + 1e-6)`, clamped to the source
frame count. Equal values hold; step interpolation cuts. Multiple layers can
reference different frames of the same asset. `measure_layout` reports both
`sourceTime` and `sourceFrame`. Sources larger than the canvas retain detail on zoom.
Sequential renders keep a decoder per asset. Random previews use an LRU cache;
`videoCacheBytes` (library and render tools) bounds cached RGBA bytes per asset (default
32 MiB). Transient draw/decode buffers are additional. Library users can call
`closeVideoSources()` to release cached frames immediately.

A layer can carry `shape` instead of an asset or fill:

```json
{"id":"outline","x":500,"y":300,"width":200,"height":80,
 "shape":{"type":"rect","cornerRadius":14,"fill":null,"stroke":"#3b82f6",
 "strokeWidth":3,"strokeAlign":"outside"}}
```

Shapes support `rect`, `ellipse`, and `path` (`d` in layer-box pixels), optional
`fill`/`stroke` colors, `strokeWidth`, `strokeAlign` (`inside`, `center`, `outside`),
and `shadow: {color,blur,x,y}`. Shape geometry is rasterized under the complete
transform, without a pre-scaled image. `cornerRadius`, `strokeWidth`, and
`shadowBlur` are continuous animation properties; `shapeFill` and `stroke` are
step color tracks. SVG paths accept only M/L/H/V/C/S/Q/T/A/Z commands and finite
numeric arguments, up to 65,536 characters. New content conflicts are errors;
legacy image+fill layers retain the previous `FILL_IGNORED` warning for compatibility.

`space: "screen"` ignores the camera; omitted/`world` keeps existing behavior.
Parent transforms, opacity and visibility still apply. A mixed-space child uses
the inherited numeric transform in its own chosen space.

An inverted shape mask makes a spotlight. `shape.feather` is a blur radius in screen
pixels (0–256); it softens the alpha edge, independently of colored shadows:

```json
[
 {"id":"hole","x":1381,"y":206,"width":180,"height":80,"visible":false,
  "shape":{"type":"rect","cornerRadius":14,"fill":"#ffffffff","feather":8}},
 {"id":"dim","x":960,"y":540,"width":1920,"height":1080,"space":"screen",
  "fill":"#000000","opacity":0.55,"z":35,
  "mask":{"type":"layer","layer":"hole","invert":true}}
]
```

Audio tracks add `sourceIn`/`sourceOut` in seconds, `startOffsetMs` from 0 to one
frame, and `fadeInMs`/`fadeOutMs` (default zero). Trims reset timestamps before
placement, fades operate on the trimmed clip, and overlapping clips mix without
normalization. Range validation probes the file when trim/fade-out fields are used.
`add_audio {track}`, `update_audio {index,patch}`, and `remove_audio {index}` edit
tracks transactionally. Generated character speech must be edited through its owner.

`render_video` adds `subtitles: {file,mode,fontsDir?}` and `chunks` (1–16).
Burn mode accepts ASS/SRT and requires an explicit font directory with TTF/OTF/TTC
files; soft mode accepts SRT/VTT and muxes MP4 mov_text. Fonts and subtitle paths
are copied to safe job-local names. Fontconfig is isolated from installed fonts.
No subtitle options means the original encoding arguments are preserved.
`capabilities {fontsDir?}` reports the FFmpeg build, video decode, libass burn,
and runtime FriBidi/HarfBuzz shaping diagnostics. Unsupported shaping is reported
as `SUBTITLE_SHAPING_UNAVAILABLE`, not silently claimed successful.

`subtitlesFromTiming(blocks, options)` is pure and returns `ass`, `srt`, `cues`, and
warnings. The `subtitles_from_timing` tool writes both files in `outDir`. Each block
has `timing: SpeechTiming`, `startFrame`, optional `startOffsetMs`, `sourceIn`, and
`sourceOut`. Options include `fps`, `width`, `height`, `maxCharacters`, `maxLines`
(1–2), `minDuration`, `maxDuration`, `pauseThreshold`, and an explicit style
(`font`, `size`, `outline`, `margin`, `position` 1–9, `direction`). The builder
breaks at whitespace, punctuation and pauses, never inside a word. Impossible
word limits are errors; minimum duration yields to the next cue/trim boundary
with a warning. Persian uses RTL embedding; Korean keeps eojeol intact.

Chunk workers render lossless FFV1/BGRA intermediates, concatenate with stream
copy, then perform a single final encode with audio/subtitles. This uses more
scratch disk and I/O than direct rendering; it is intended to preserve pixels
across chunk boundaries. Equivalence tests are included for the Reviewer.

New issue codes: `VIDEO_NOT_PREPARED`, `VIDEO_HASH_MISMATCH`, `MISSING_VIDEO_FILE`,
`SOURCE_TIME_OUT_OF_RANGE` (warning with inclusive scene-frame ranges),
`CONFLICTING_CONTENT`, `INVALID_SHAPE`, `INVALID_PATH_DATA`, `INVALID_AUDIO_RANGE`,
`MISSING_SUBTITLE_FILE`, `SUBTITLE_SHAPING_UNAVAILABLE` (warning). Operation errors
also include `MEDIA_PROBE_FAILED`, `VIDEO_DECODE_FAILED`, `WOULD_OVERWRITE`,
`INVALID_SPEECH_TIMING`, `SUBTITLE_WORD_TOO_LONG`, and `OVERLAPPING_SUBTITLES`.

See [the implementation report](docs/VIDEO_COMPOSITING_REPORT.md) for verification
status and deviations. Generate the proof with
`FFMPEG_PATH=/usr/bin/ffmpeg FFPROBE_PATH=/usr/bin/ffprobe npx tsx examples/footage-proof/run.ts`.
The committed narration/font fixtures make re-renders offline. Only the explicit
`npx tsx integrations/elevenlabs/regenerate.ts` script uses `ELEVENLABS_API_KEY`.

Partial renders keep scene-relative subtitle timing and retain audio clips that overlap the start of the requested range. Trimming occurs after clip fades, so a cropped range does not restart a fade. Audio extensions and subtitle encoding also apply to 3D outputs; parallel chunks currently support 2D scenes only. Library callers should serialize operations on each `AnimationEngine` instance; workspace video jobs use independent instances. ASS cue text is treated as literal text: braces are removed and backslashes replaced with a full-width character to prevent override-tag injection.
