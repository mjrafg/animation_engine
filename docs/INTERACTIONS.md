# Multi-character interactions

**Place two prepared characters, then say which interaction happens, between whom, when, and for how long.** The engine handles the choreography: it gets the actors into place, turns them to face each other, reaches, makes contact, moves, releases and returns.

```jsonc
// interaction_apply: one atomic batch
{ "sceneId": "s", "operations": [
  { "type": "add", "interaction": { "interaction": "handshake",   "actors": ["anna", "ben"], "start": 11, "duration": 3 } },
  { "type": "add", "interaction": { "interaction": "give_object", "actors": ["anna", "ben"], "start": 15, "params": { "object": "mug" } } },
  { "type": "add", "interaction": { "interaction": "hug",         "actors": ["ben", "anna"], "start": 19 } } ] }
```

The characters keep their own high-level actions (walk, talk, smile, blink, …) from `character_actions`. The interactions add to them, and **both compile into the same canonical timeline**:

- **2D:** the actors' generated layers and tracks.
- **3D:** objects, tracks and `ik` chains.

Rendering, measuring, saving and reloading work exactly as for any other scene content. Nothing here is keyframed by hand.

This extends the [character runtime](CHARACTERS.md); it does not replace it.

## How an interaction becomes animation

```text
 interaction definition (data)     scene: interactions[]               character plans (per actor)        compiled content
 ────────────────────────────      ─────────────────────               ───────────────────────────        ────────────────
 roles + requirements,       ──►   {id, interaction, actors,     ──►   + approach walk, turn,       ──►   2D: part rotations (IK),
 alignment, phases,                 start, duration, params}           hold, step back                    hand art, prop copies
 targets, effectors,                                                   (source = interaction id)          3D: ik chains + tracks,
 moves, transfer                                                       + per-frame arm targets             prop copies
```

`planScene` (in `src/characters/interactions.ts`) plans every character of the scene together.

1. **Alignment (in start order).**
   - It starts from where each actor is at the interaction's start, with its own earlier actions and interactions applied.
   - It computes where the actors must stand: face to face, at a distance derived from their own arm reach, shoulder height and body height.
   - The anchor actor stays in place (default: the second actor; `params.anchor` = `first` | `second` | `midpoint`). The other actor walks there during the `approach` phase at its own walking speed.
   - Actors that are already close enough (within 3% of their height) do not shuffle; the arms absorb the difference.
2. **Injected plan actions.** The runtime adds ordinary plan actions to each actor, marked with `source` = the interaction id:
   - `approach` (walk);
   - `face` (turn toward the partner);
   - `wait` and `hold` (idle, which reserves the locomotion channel);
   - `back` (step back while keeping the facing, as in a push).

   They follow the normal channel and conflict rules of the character runtime. `character_timeline` lists them as `interactionActions`.
3. **Reaches.** Each effector (role + hand + target) becomes a per-frame world target and a weight. The weight ramps in over its `from` phase, stays at 1 during contact, and ramps out from its `until` phase to the end.
   - Targets are recomputed from the actors' actual positions every frame, so hands follow a partner who moves (push).
   - A handshake target oscillates during `motion` (the shake).
4. **Arm solving: two-bone IK, analytic, exact when reachable.** This is not a general IK system.
   - **2D:** the compiler rotates the upper arm and forearm parts so the hand's socket point, for example `hand_r:grip`, lands on the target. It blends with the animated pose by weight, and the elbow bends downward. It can also swap the hand art (for example `hand_open` for a high five).
   - **3D:** the compiler emits `ik` chains on the character object, for example `ik.right = {upper, lower, end, grip, side}` with tracks `ik.right.target.x|y|z` and `ik.right.weight`.
     - The Blender backend solves the arm after the animation clips and before attachments. The pole is behind, below and outside the shoulder in the character's own frame.
     - The palm point, `grip` metres along the hand, lands on the target.
     - `ik` chains are ordinary, validated scene data. They can also be used without interactions.
5. **Object transfer** (`give_object` / `receive_object`):
   - The giver's prop stays visible until the transfer frame (the start of the `release` phase, when both hands are on the target).
   - From that frame, a copy attached to the receiver's hand is shown instead. The attachment switches exactly once.
   - The copy's offset is computed so the object does not jump:
     - **2D:** exactly, from both hands' matrices; mirrored characters get a mirrored copy.
     - **3D:** from the solved contact geometry, keeping the world orientation.
   - Ownership chains: A gives to B, then B can give it on (or back).

Everything is a pure function of the stored data (instances, interactions, definitions, speech timings), so **save, reload and re-render reproduce it byte for byte**.

## Built-in interactions

| id | Roles (actor order) | Default | What happens |
|---|---|---|---|
| `handshake` | `a` (approaches), `b` | 3 s | Right hands (`params.hand`) meet between the actors below shoulder height and shake. |
| `high_five` | `a`, `b` | 2 s | Raised open hands meet above shoulder height. |
| `hug` | `a`, `b` | 3.5 s | They step close; each wraps both arms around the other's back. |
| `give_object` | `giver`, `receiver` | 3 s | `params.object` (a prop the giver holds) is handed over. |
| `receive_object` | `receiver`, `giver` | 3 s | Same, with the receiver approaching. |
| `push` | `pusher`, `pushed` | 2.5 s | Both hands shove the partner's chest; the pushed actor steps back (no physics). |

`interaction_list` shows them, plus any custom ones. `interaction_list {interactionId}` shows the complete definition: roles and requirements, parameters, phases, alignment, targets, effectors, and the channels it owns.

Phases use the standard names `approach`, `reach`, `contact`, `motion`, `release` and `return`, each as a fraction of the duration. For example, the handshake phases are:

| Phase | Ends at |
|---|---|
| approach | 0.30 |
| reach | 0.45 |
| contact | 0.52 |
| motion | 0.78 |
| release | 0.88 |
| return | 1.00 |

## Channels, coexistence and conflicts

During its window, an interaction **owns, for each of its actors**:

- **locomotion:** approach, hold and step back;
- **facing:** turn toward the partner;
- **the arms it uses.**

Everything else keeps working:

- **talk:** mouth, speech timing, voice audio;
- **expressions:** smile and others;
- **blinks:** scheduled and automatic;
- **2D gestures on parts the interaction does not use.**

Conflicts are structured `ACTION_CONFLICT` errors that name both sides and the interaction:

```json
{ "code": "ACTION_CONFLICT", "details": { "actions": ["a3", "ix1:hold"], "channel": "locomotion", "interactions": ["ix1"], "instance": "b" } }
```

They are raised for:

- a walk or run that overlaps the interaction;
- a turn during the interaction (channel `facing`);
- a gesture that uses a reaching arm (channel `body-part`). In 3D any gesture conflicts, because gestures are full-body clips.
- two interactions that overlap on the same actor.

Every operation is atomic. A failed batch changes nothing.

## Different sizes

All distances and heights come from each actor's own dimensions:

- 2D: rest-pose forward kinematics of the rig, times the instance scale.
- 3D: the model's rest joint positions, times the definition scale and the instance scale.

The adaptation works like this:

- The face-to-face distance is the sum of how far forward each arm reaches at the shared target height, and it is capped so every hand with a body target (hug, push) can reach it.
- A shared target (handshake, give) splits the gap in proportion to the two reaches, so a small character does not over-stretch.
- Heights mix both actors' shoulders and the shorter arm.

Measured results are in `docs/interactions/REPORT.md`:

- 3D handshake with partners at scale 0.65, 0.8 and 1.2: palms meet within 0.5 mm.
- 2D handshake with partners at scale 0.5 to 1.5: grips meet within 0.3 px.

**Limits, reported rather than hidden:**

- When a hand cannot reach its target (arm too short for the requested height, or an extreme size difference), the interaction still plays. The arm stretches toward the target, and an `INTERACTION_OUT_OF_REACH` warning names the actor, the hand and the predicted miss.
- The same warning appears when an approach is faster than 2.2× the character's walk speed (`INTERACTION_FAST_APPROACH`).
- The test character Pip has short arms (about 21% of its height) and a big head. So its 2D high five happens at face height, and in a 2D hug the heads overlap.
- The IK moves only the arms. The body does not lean or bend, and there are no collisions: in a hug the arms may pass slightly into the partner's mesh.
- The 3D grip point is estimated from the forearm length (30%).
- A transferred 3D prop that followed the hand bone fully (`follow:"full"`) keeps its world orientation at the switch (`TRANSFER_ORIENTATION_APPROX`). Use `follow:"position"` on props that are handed over for an exact match.

## Custom interactions (no code changes)

A definition is data. The built-ins use the same JSON schema (`InteractionDefinitionSchema` in `src/characters/interaction-defs.ts`). Register one per workspace with `interaction_define`, either `{definition}` or `{source: {library, path}}`. Then apply it like a built-in.

Example: `assets/interactions/professor_greeting.json`. The professor waits (`anchor: "first"`), the student walks up, and they shake hands slowly for longer:

```jsonc
{ "id": "professor_greeting",
  "roles": [ { "name": "professor", "requires": { "sockets": ["rightHand"] } },
             { "name": "student",   "requires": { "actions": ["walk"], "sockets": ["rightHand"] } } ],
  "duration": { "default": 4, "min": 2 },
  "alignment": { "mode": "face_to_face", "distance": { "reach": 0.92 }, "anchor": "first" },
  "phases": [ { "name": "approach", "end": 0.3 }, { "name": "reach", "end": 0.42 }, { "name": "contact", "end": 0.5 },
              { "name": "motion", "end": 0.8 }, { "name": "release", "end": 0.9 }, { "name": "return", "end": 1 } ],
  "targets": { "grip": { "kind": "between", "height": { "shoulder": 1, "reach": -0.5 }, "along": "reach",
                         "shake": { "phase": "motion", "amplitude": 0.012, "frequency": 1.5 } } },
  "effectors": [ { "role": "professor", "hand": "right", "target": "grip", "from": "reach", "until": "release" },
                 { "role": "student",   "hand": "right", "target": "grip", "from": "reach", "until": "release" } ] }
```

### Schema reference

- **`roles`:** `{name, requires: {actions, sockets}}`. One actor per role, in order.
- **`duration`:** `{default, min}` in seconds.
- **`params`:** interaction-specific parameters (for example `object`). The parameters `anchor` and `hand` always exist.
- **`alignment`:**
  - `{mode: face_to_face | none, anchor}`;
  - `distance: {reach: fraction of arm reach, roles?, height: × average height}`;
  - `height?`: the shared target height used for the distance.
- **`phases`:** `[{name, end: fraction}]`. A phase named `approach` is where actors walk into place.
- **`targets`:**
  - `{kind: "between", height, along: "reach" | fraction, shake?}`: a point on the line between the first two actors.
  - `{kind: "partner", of: role, height, heightFrom: partner | both, forward, lateral}`: a point on an actor's body. `forward` and `lateral` are multiples of that actor's height; `lateral` is positive toward its left.
  - `height` is `{shoulder?, reach?, height?}`, meaning shoulder × k + shorter arm × k + height × k.
- **`effectors`:** `{role, hand: right | left | param | object, target, from: phase, until: phase, handPose?}`.
- **`moves`:** `{role, phase, back: × height}` (steps back, keeping its facing).
- **`transfer`:** `{from: role, to: role, at: phase}`. The object changes hands at the start of that phase.

Validation reports unknown roles, targets and phases, ends that do not increase, and more, as `INTERACTION_INVALID` with paths. Defining the same content again is a no-op. A changed definition needs `replace: true`. Scenes that used the old version are marked `stale` in `interaction_inspect` until they are recompiled (`character_update {}`). Built-in ids cannot be redefined.

## Discovery, compatibility, inspection

| Tool | Returns |
|---|---|
| `interaction_list` | Built-in and custom interactions: actor count, roles, duration, parameters. With `interactionId`, the full description, including owned and concurrent channels. With `library`, the definition files in a library. |
| `interaction_check` | For characters (`[instance ids]` in a scene, or `[{character, scale}]`): compatible or not, per-role requirements and what is missing (actions, hand sockets, arm chains), plus the fit: the distance and target height the runtime would use for these sizes, each arm's forward reach, and limits as warnings. |
| `interaction_define` | Registers a custom definition. |
| `interaction_apply` | Operations `add`, `update`, `replace`, `remove`, `shift` and `clear`, atomically; returns the resolved timeline. |
| `interaction_inspect` | Per interaction:<br>• phases (seconds and frames);<br>• alignment (from, to, facing, distance);<br>• injected actions;<br>• contact targets and windows, and predicted reach misses;<br>• the transfer (object, from, to, frame, layers);<br>• every object's ownership history.<br><br>With `frame`, it adds:<br>• active phases;<br>• actor positions and facing;<br>• hand targets and weights;<br>• who holds each object;<br>• **measured** grip positions and grip-to-partner-hand distances, from the renderer's layout (2D) or the Blender backend (3D). |

`character_remove` refuses to remove a character that is in an interaction (`CHARACTER_IN_INTERACTION`), unless it gets `removeInteractions: true`. Then those interactions are removed too, and the other characters are recompiled, so objects received from it disappear.

Core API equivalents: `applyInteractionOps`, `interactionTimeline`, `checkInteraction`, `describeInteraction`, `ws.defineInteraction`, `ws.listInteractions` and `ws.inspectInteractions`.

## Editing and persistence

Interactions live in the scene document (`interactions[]`, with `definitionSha`). You can move an interaction later (`shift`, `update start`), extend it (`update duration`), replace it with another, or remove it; removing restores the plain character timeline exactly. Any change to characters or interactions recompiles all characters of the scene together, because interacting actors are coupled. Scenes without interactions keep the per-instance recompiles.

## Errors and warnings

| Code | When |
|---|---|
| `INTERACTION_NOT_FOUND` | Unknown definition or interaction id. |
| `INTERACTION_INVALID` | Wrong actor count, duration below the minimum, a missing required parameter, no approach time to get into place, or an invalid custom definition. |
| `INTERACTION_INCOMPATIBLE` | An actor lacks what its role needs: a hand socket or arm chain (details list what is missing), or `walk` when it has to approach. |
| `INTERACTION_OBJECT_NOT_HELD` | The giver does not hold `params.object` at that time. Details list what it holds. |
| `INTERACTION_EXISTS` | Redefining a built-in id, or changing a custom one without `replace`. |
| `ACTION_CONFLICT` | Overlaps on locomotion, facing or arms. Details name the actions, the channel and the interactions. |
| `CHARACTER_IN_INTERACTION` | Removing an actor that has interactions. |
| Warnings: `INTERACTION_OUT_OF_REACH`, `INTERACTION_FAST_APPROACH`, `TRANSFER_ORIENTATION_APPROX` | Limits, as above. |

## Out of scope

Physics, collisions, fighting, motion planning, full-body IK and motion capture are not part of this system.

## Tests and proof

- `tests/interactions.test.ts`, 12 tests:
  - the library;
  - custom definitions;
  - 2D handshake contact, measured;
  - coexistence and conflicts;
  - incompatibility;
  - object transfer with save and reload;
  - editing;
  - removal;
  - different sizes and limits;
  - independent multi-character speech;
  - 3D compile;
  - 3D contact and transfer, measured in Blender.
- `tests/mcp/mcpinteract.test.ts`: the five tools over real stdio.
- `npx tsx examples/interactions-proof/run.ts` renders the conversation scene and the 3D and 2D showcases, and measures every claim. Results: [`docs/interactions/REPORT.md`](interactions/REPORT.md).
