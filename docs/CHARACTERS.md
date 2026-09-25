# Character runtime: prepared characters and high-level actions

**Prepare a character once. Then say what it does, when, for how long and where.** The engine handles the animation.

```jsonc
// one character_actions call: the whole performance
{ "character": "pip1", "operations": [
  { "type": "add", "action": { "action": "walk",  "start": 2,   "duration": 3, "direction": "right" } },
  { "type": "add", "action": { "action": "talk",  "start": 5.5, "speech": "hello" } },       // speech timing id
  { "type": "add", "action": { "action": "smile", "start": 6,   "duration": 4 } },           // while talking
  { "type": "add", "action": { "action": "blink", "start": 7,   "duration": 1.2, "count": 2 } },
  { "type": "add", "action": { "action": "wave",  "start": 8.5, "duration": 1.2 } },
  { "type": "add", "action": { "action": "walk",  "start": 10,  "duration": 2, "to": { "x": 220 } } } ] }
```

For the 2D test character Pip, that single call produces 20 tracks and a few hundred keyframes, generated automatically. This covers:

- the walk cycles and root motion;
- mirroring to face left;
- idle breathing in the gaps;
- 8-shape lip sync with a smile variant;
- brows, blinks and the arm wave, with blending between them all.

The same call drives the 3D character Mika through animation clips, turning, morph targets and blinks.

## Architecture

```text
 character package (prepared ONCE)          scene document (canonical)                  existing engine
 ─────────────────────────────────          ──────────────────────────                  ───────────────
 character.json: rig/model, motions   ──►   characters: [{ id, character, placement, ──► layers/objects + keyframe
 or clips, expressions, mouth shapes,       props, actions: [high-level actions] }]        tracks (owner = instance)
 eyes, sockets, action definitions          │                                              │
 + art files / GLB                          └── runtime compiles (deterministic) ─────────┘──► render / measure / MP4
```

- **Character package:** a directory with `character.json` plus its art (2D part images) or a model (3D GLB). `character_import` prepares it in a workspace **once**. Its files become workspace assets (`pip.head`, `mika.model`, …) and its definition is stored under a stable `characterId`. Importing it again is a no-op. Any number of scenes and instances reuse it.
- **Instance:** lives in the scene document at `characters[]`: `{id, character, x/y | position, scale, facing, z, autoBlink, props[], actions[]}`. The action list is the editable high-level state: it is saved with the scene, reloaded, and can be changed later.
- **Compilation:** the runtime turns the instance into ordinary scene content.
  - **2D:** layers `<id>` (root) and `<id>.<part>`.
  - **3D:** an object `<id>` with the model, plus prop objects.
  - **Both:** ordinary keyframe tracks.

  All of it is marked (`meta.character` on layers/objects, `owner` on tracks and audio). The **timeline stays canonical**: `timeline_get`, `measure_layout`, `render_*` and video rendering see normal tracks. Nothing is hidden, and every frame renders deterministically.
- **Recompiling:** each action edit recompiles only that instance, replacing exactly what it owns. Hand-made layers, objects and tracks are never touched.
  - Low-level edits of character-owned tracks or layers are refused with `OWNED_BY_CHARACTER`, because they would be lost on the next recompile.
  - You *can* add your own content on the character, for example a hat layer parented to `pip1.head`.
- **Evaluation:** the compiler evaluates the composed pose at every frame (motions, blends, overrides, expressions, visemes, blinks, facing, path). It then stores only the keys needed to reproduce it: linear segments within 0.08 px/° (2D) or 2 mm (3D), and step keys for asset swaps and clips.

Code: `src/characters/`:

| File | Purpose |
|---|---|
| `schema.ts` | Definition, instance, action and speech schemas |
| `plan.ts` | Actions → plan: channels, conflicts, path, facing, visemes, blinks |
| `compile.ts` | 2D and 3D compilers |
| `speech.ts` | Visemes and the generic talk fallback |
| `operations.ts` | Scene operations and inspection |
| `capabilities.ts` | Capability discovery |

The workspace (`src/workspace/workspace.ts`) stores packages and speech timings. MCP (`mcp/src/tools.ts`) is a thin wrapper.

## Actions

| Action | Kind / channel | Parameters | 2D implementation | 3D implementation |
|---|---|---|---|---|
| `idle` | idle / locomotion | start, duration | idle motion preset (also fills every gap) | idle clip (also fills gaps) |
| `walk`, `run` | locomotion | start + one of duration, distance or `to`; `direction` (2D: left, right; 3D: also camera, away); `speed` | cycle preset on the legs and arms, root x/y path, facing by mirroring (`scaleX`) | clip, root position path, turning (yaw) |
| `talk` | speech / mouth | start, duration (default: speech length), `speech` (timing id or inline), intensity, seed | mouth part asset per viseme; expression-specific mouth sets | mouth morph targets per viseme, 2-frame crossfade |
| `smile`, `sad`, `surprised`, … or `expression {expression}` | expression | start, duration, intensity | part asset swaps and offsets (brows, eyes, head tilt) + mouth set | morph weights, blended in and out |
| `neutral` | expression | start, duration | explicitly neutral | explicitly neutral |
| `blink` | eyes | start, duration, `count` or `interval`, seed | eyes part → closed asset | blink morph, triangular |
| `wave`, `point` | gesture | start, duration | preset on the arm parts it claims, hand asset swap; overrides the walk arm swing only on those parts | full-body clip |
| `look` | gesture (head) | direction up, down or forward | head preset | not in the 3D test character |
| `turn` | facing | direction (2D: left, right; 3D: also camera, away), duration (turn time) | mirror flip over the turn time | smooth yaw turn |

- **Extensible:** a character adds actions in its definition (`actions: {name: {kind, motion | clip, speed?, claims?}}`), for example a new gesture or a skip locomotion, without engine code. New action *kinds* are engine features.
- **Discoverable:** `character_inspect` lists every action with its channel, parameters, directions and default speed. It also lists expressions, mouth shapes, sockets, motions or clips, units, supported combinations and the composition rules. Not every character supports everything: Mika has no `sad` or `look`, and that shows in the listing.

### Channels, composition and conflicts (deterministic rules)

| Channel | Rule |
|---|---|
| locomotion (walk, run, idle, …) | One at a time; overlapping locomotion → `ACTION_CONFLICT` (naming both actions and the channel). Gaps play idle. |
| gesture (wave, point, look, …) | Each gesture *claims* body parts. Two gestures on the same part at once → `ACTION_CONFLICT` (with `parts`).<br>2D: a gesture overrides locomotion only on its parts, so walk + wave works: legs walk, one arm waves.<br>3D: a gesture is a full-body clip, so gesture + walk/run is a conflict. |
| expression | One at a time → conflict when overlapping. Neutral when none. |
| mouth (talk) | One at a time. Combines with any expression: smile-specific mouth shapes when the character has them. |
| eyes (blink) | Never conflicts; overlapping blinks merge. `autoBlink` (default on) adds seeded background blinks that stay at least 1 s away from scheduled blinks. `character_timeline` labels each blink `autoBlink` or `action <id>`. |
| facing (turn) | walk and run face their direction themselves; a turn during a move → conflict. |

Transitions blend over the character's `blend` time (Pip 0.2 s, Mika 0.25 s). Clips crossfade over `blendFrames`.

Other errors, all structured with details:

- `ACTION_NOT_SUPPORTED`: unknown action or expression, with the supported list;
- `INVALID_ACTION`: missing duration or direction, or an unsupported direction;
- `ACTION_OUT_OF_RANGE`: start after the scene end; past-end actions give a warning and are cut;
- `SPEECH_NOT_FOUND`, `ACTION_NOT_FOUND`, `CHARACTER_NOT_FOUND`, and `BONE_NOT_FOUND` (unknown socket for a prop).

Every batch is atomic: a failure changes nothing and names `operations[i]`.

### Movement and direction

- `walk`/`run` take `direction` plus duration or distance, or a target `to`:
  - 2D: `{x, y?}` in canvas pixels;
  - 3D: `{x, z?}` in metres.

  Duration comes from the speed if not given; if given, the speed follows from it.
- The default speed is per character at scale 1 and is **multiplied by the instance `scale`**: Pip walks 200 px/s at scale 1 and 260 px/s at scale 1.3. `character_timeline` echoes the effective `speed`.
- Positions chain: each move starts where the previous one ended. `character_timeline` reports each move's `from`, `to` and effective `speed`.
- **2D:** left and right are implemented by mirroring the prepared right-facing rig. **3D:** real orientation (yaw toward the travel direction) and world movement. Callers never see the difference.

### Editing

`character_actions` ops:

- `add`
- `update {id, patch}`, e.g. start later or a longer duration
- `replace {id, action}`, e.g. walk → run, keeping the id
- `remove {id}`
- `shift {by, after?|ids?}`: move a block of actions in time
- `clear {actions?}`

Action ids are stable (`a1`, `a2`, … or your own). Each edit recompiles from the stored actions; nothing is rebuilt by hand.

## Speech (provider-neutral)

`speech_timing_save {timingId, timing}` stores:

```jsonc
{ "audio": "voice_line_01",            // optional audio asset: added to the scene audio at the talk start
  "text": "Hello! My name is Pip.",   // optional, informational
  "duration": 3.5,                    // optional
  // ONE of (most precise first):
  "visemes":    [{ "viseme": "AI", "start": 0.05, "end": 0.12 }, ...],     // rest MBP AI E O U FV L
  "characters": [{ "char": "H", "start": 0.05, "end": 0.125 }, ...],       // character alignment (common TTS output)
  "words":      [{ "word": "Hello", "start": 0.05, "end": 0.42 }, ...] }  // word alignment
```

- **How timing becomes mouth shapes:**
  - Characters map to 8 normalised visemes by a fixed letter table.
  - Words are spread over their letters.
  - Shapes shorter than 1.5 frames are merged, so there is no flicker.
  - Characters map visemes onto their own art (2D mouth assets) or morph weights (3D). Missing shapes fall back along FV→MBP→rest, L→E, U→O, O→AI, E→AI.
- **No timing:** a deterministic generic talk, seeded by the instance id and an optional `seed`, animates the mouth for the given duration. It can later be replaced by a precise timing with one `update`.
- **Self-contained scenes:** the talk action stores an inline copy of the timing (plus `speechId`), so a scene never changes when a saved timing is edited later.
- **No provider dependency:** the engine knows nothing about ElevenLabs or any other provider. Tandem converts provider output (for example character alignments) into this schema.

## Props at sockets

`props: [{id, asset, socket: "rightHand", x?, y?, rotation?, scale?, z?, visibleFrom?, visibleUntil?}]` on the instance, set with `character_add` or `character_update`.

- **2D:** the prop becomes a layer parented to the socket's part and attachment point, e.g. `hand_r:grip`. It follows every motion and gesture, and it mirrors with the character.
- **3D:** it becomes an object `attach`ed to the socket bone. `follow: "position"` keeps it upright.
- **Detaching:** remove the prop from the list. `visibleFrom`/`visibleUntil` make it appear or disappear in time.

## Package format

**2D** (`assets/characters/pip/character.json`, generated by `assets/characters/src/build-pip.ts`):

- `assets` maps names to files.
- `rig.parts`: the parent chain, pivots, z order, attachment points, and the facing of the artwork.
- `sockets`: `rightHand → {part: hand_r, point: grip}`.
- `motions`: reusable presets, `{duration, loop, tracks: {"thigh_r.rotation": [[t, offset], …]}, assets?: {part: asset}, blend?}`. Offsets are added to the rest pose.
- `expressions`: part asset swaps and offsets, plus `mouthSet`.
- `mouth`: `{part, sets: {neutral: {rest, MBP, AI, E, O, U, FV, L}, smile: {...}}}`.
- `eyes`: `{part, open, closed}`.
- `actions` and `defaults`.

**3D** (`assets/characters/mika/character.json` + `mika.glb`):

- `model`, `scale`, `blendFrames`;
- `actions` map action names to clips, with speeds;
- `expressions` map to morph weights;
- `mouth.sets` map each viseme to morph weights;
- `eyes.blink` gives the blink morph weights;
- sockets come from the model (rightHand, head, …) plus optional overrides.

Packages live in a read-only library that the operator configures, e.g. `VIDEO_ENGINE_LIBRARIES="characters=/opt/animation_engine/assets/characters"`.

## Determinism and cost

- **Deterministic:** the same package, scene, actions, timing and assets always give the same compiled document and the same pixels.
  - Randomness (generic talk, blink jitter, background blinks) comes from a seeded PRNG (mulberry32) keyed by the instance id and optional seed.
  - Tests check that the saved document, a reloaded one and a recompiled one are byte-identical, and that rendered frame hashes match after reload.
- **Cost model:** prepare once, then reuse the character, its actions and its animation, and render locally.
  - No generation happens per movement.
  - Compiling a 12 s schedule takes about 25 ms.
  - The 12.5 s 720p 2D proof video renders in about 3 s. 3D renders at about 1.5 s per frame (draft, CPU).
  - An agent needs one `character_actions` call for a whole performance, versus hundreds of keyframes by hand.

## MCP tools (9 new; the low-level tools remain)

| Tool | |
|---|---|
| `character_list` | Prepared characters and speech timings; with `library`, the available packages |
| `character_import` | Prepare a package once (`reused: true` on repeat) |
| `character_inspect` | Capabilities (actions, expressions, speech, sockets, combinations, rules) |
| `character_add` / `character_update` / `character_remove` | Place, change placement or props, remove |
| `character_actions` | Atomic batch of add/update/replace/remove/shift/clear; returns the resolved schedule |
| `character_timeline` | Resolved schedule: seconds and frames, channels, paths, speech source, blinks, generated content, staleness |
| `speech_timing_save` | Provider-neutral timing (visemes, characters or words, plus optional audio) |

`engine_capabilities.characters` summarises the runtime: kinds, channels, rules, visemes and tools.

## Proofs and tests

- **`examples/characters-proof/run.ts`** runs the same high-level schedule on Pip (2D) and Mika (3D) with a synthesized voice line from the speech fixture: idle → walk right → talk with speech timing + smile + blinks → wave → walk back to the start. Output: `out/pip_2d.mp4`, `out/mika_3d.mp4`, contact sheets and a `report.json` with 9 checks.
- **`tests/characters.test.ts`** covers:
  - package validation and capabilities, and preparation-once;
  - viseme mapping and determinism;
  - the required composition, checked by measured positions, facing, mouth sets, blinks and legs;
  - speech timing driving the exact mouth shapes, plus talk + smile + blink;
  - walk + talk + wave composition, and a prop at a socket measured every frame;
  - 14 conflict and error cases with the scene unchanged;
  - editing (move, extend, remove, replace), hand-made content surviving, the ownership guard;
  - persistence: reload plus identical pixels, and a byte-identical recompile;
  - the low-level path coexisting in the same scene;
  - 3D: clips, yaw, path, morphs, the 3D conflict rule, and the Blender-measured prop following the hand.
- **`tests/mcp/mcpchar.test.ts`** repeats this over MCP stdio.
- **Agent E2E:** [`tandem-e2e-characters/REPORT.md`](tandem-e2e-characters/REPORT.md).

## Limits

- **Lip-sync precision** is set by the provided timing. With only text, or nothing, the fallback is generic mouth movement.
- **Walk cycles** are in-place presets moved along a straight path at constant speed, so feet can slide if the speed doesn't match the stride. There is no path planning or IK.
- **2D turning** mirrors the artwork: there is no front or back view unless a character package adds such parts.
- **3D gestures** are full-body clips, so they can't be layered on locomotion unless the package provides combined clips.
