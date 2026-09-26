# Character joint continuity: verification, fixes and proof

**Requirement:** when a character's skeleton moves, the body, skin, clothing and limbs stay
visually connected. There must be no paper-cutout gaps at the shoulders, elbows, wrists, hips,
knees, ankles or neck during supported animations.

**Result:** both prepared characters now pass every check:

- **Pip (2D):** all 12 moving joints stay closed.
- **Mika (3D):** all 13 joints are skinned with blended weights.

The engine itself verifies continuity for any character at preparation time, reports it as
`continuity.productionReady`, and warns when a non-continuous character is placed.

| | Before | After |
|---|---|---|
| Stress proof (`examples/continuity-proof`), 10 checks | **0/10** with the original assets | **10/10** |
| 2D joint analysis, moving joints continuous | 6 of 12 had gaps (elbows, knees, ankles) | 12 of 12 |
| 3D skin analysis, joints blended/connected | 0 of 13 (all rigid) | 13 of 13 blended |
| Worst 2D joint ring coverage in the renders | 0.85 | 1.00 |
| Worst 3D outer "notch depth" at a bent knee/elbow (running) | 0.18 of the limb half-width | 0.64 |

Contact sheets. Each row shows a full frame plus zooms of the stressed joints, at the frame where they bend the most:

- 2D: [`before/pip_2d_stress.jpg`](before/pip_2d_stress.jpg) → [`after/pip_2d_stress.jpg`](after/pip_2d_stress.jpg)
- 3D: [`before/mika_3d_stress.jpg`](before/mika_3d_stress.jpg) → [`after/mika_3d_stress.jpg`](after/mika_3d_stress.jpg)
- Numbers: `before/report.json`, `after/report.json`

## 1. What was already solved

- **3D skinning in the engine.** The 3D backend imports glTF skins and deforms meshes through Blender's armature (linear-blend) skinning. Clips and every per-frame pose drive the bones, and the skinned surface follows.
  - Checked with third-party models: Fox, CesiumMan and RiggedFigure are fully weight-blended at every joint (up to 4 influences per vertex).
  - They deform as one continuous surface, and nothing in the engine separates them.
- **Attachments** already followed bones (measured to under 1 cm).
- **2D:** shoulders, hips, neck and waist already stayed closed. The torso and pelvis are large enough to cover those joints, and the head art includes a neck column.

## 2. What was missing

- **3D test character (Mika):** built as 20 separate rigid boxes, each weighted 100% to one bone. This is skinning in name only.
  - At every joint the pieces simply met.
  - Bending opened wedge-shaped notches and splits: clearly visible in profile at the knees when walking and running, at the elbows, and at the shoulders when waving (`before/mika_3d_stress.jpg`).
  - The engine had no way to notice this: it never looked at skin weights.
- **2D (Pip):** layered parts only, with pivots and sockets and no mesh deformation.
  - The art used rounded rectangles whose ends were not centred on the joint pivots (elbow: 2.8 px and 4.5 px off). At the bends the motions use (knees up to 80° when running, elbows 75°, ankles 10°) this opened notches and showed seam arcs.
  - The engine had no continuity check for 2D rigs either.
  - Separate bug: Pip's hand parts had no declared size, so they rendered at their 2x source resolution (oversized hands).

## 3. What was changed

### Engine (general, for any character)

- **3D skin analysis** (`src/scene3d/skinning.ts`, run by `inspectGltf` on every model import):
  - Reads the binary vertex data: `JOINTS_n`, `WEIGHTS_n` and the triangle indices.
  - Classifies each moving joint against its parent as `blended` (vertices share both bones), `connected` (one surface spans both) or `rigid` (separate pieces).
  - A model is continuous when no joint is rigid.
  - Linear-blend skinning never tears a connected surface, so `blended` and `connected` joints stay attached in every pose.
  - Reported in `asset_inspect` as `model.skinning`.
- **2D joint-disk analysis** (`src/characters/continuity.ts`):
  - For every parent→child joint it rasterises the real part images, the same pixels the renderer draws, in the parent's frame.
  - It rotates the child through the angle range its motions and expressions actually use, and measures how much of the joint disk the two parts cover. The disk is centred on the pivot, with the limb half-width as its radius.
  - A joint is continuous at ≥ 0.985 coverage over the whole range; joints that never rotate are `static`.
- **Production readiness:**
  - The analysis runs once at `character_import` and is stored with the prepared character.
  - `character_inspect` returns `continuity: {productionReady, …per-joint details}`.
  - `character_add` returns a `CHARACTER_NOT_CONTINUOUS` warning for a character that can show gaps. Tests cover this with a deliberately butt-jointed copy of Pip.
- **Measurement:** 3D bone measurements now also report each bone's tail (world and screen), which the render checks need.

### Characters (the smallest coherent fix for each renderer)

- **2D, robust overlap approach.** This fits the layered renderer and keeps the art style.
  - Pip's limbs are rebuilt as **capsule segments whose rounded ends are centred exactly on the joint pivots** (`assets/characters/src/build-pip.ts`). The parent's end cap and the child's start cap are the same disk, so the joint is closed at every angle.
  - The child's start cap is filled but not outlined, and the child draws above its parent. So there is no seam line inside the overlap, and the parent's outlined cap forms a smooth outer silhouette of the bend.
  - Hands and feet start with an unoutlined wrist or ankle disk, so the forearm and shin end continue into them.
  - Clothing continuity: the sleeve and shorts-leg caps are centred on the shoulder and hip joints, so the clothing boundary rotates with the joint instead of opening.
  - Hand parts now have explicit sizes.
- **3D, real skinning.** Mika is rebuilt (`assets/3d/src/build_assets.py`) as one continuous skinned body mesh (pelvis → torso → neck → head), plus one continuous tube per arm (shoulder → elbow → wrist → hand) and per leg (hip → knee → ankle).
  - Weights are blended smoothly across every joint: elbow and knee bands of about 12–14 cm, shoulder and hip regions shared with the torso and pelvis, and neck→head.
  - Pants, shirt, sleeve and skin are materials on the same connected surfaces.
  - The skeleton, clips (idle, walk, run, wave, point), face morphs, sockets and character definitions are unchanged, so every existing scene and action keeps working.

## 4. Tests and proofs

- **`tests/continuity.test.ts`** (7 tests):
  - 3D analysis on synthetic two-bone glTFs built in the test: rigid, connected and blended are each classified correctly.
  - The shipped 3D models (Mika, `assets/3d/character.glb`, Fox) are continuous, and Mika is blended at every joint.
  - 2D analysis on synthetic art: a butt joint is detected as a gap at 30°, 75° and 120°; a capsule joint is continuous at all three.
  - Pip: all 12 moving joints continuous, including knees at the full 80° run bend, and every part explicitly sized.
  - Production readiness and the `CHARACTER_NOT_CONTINUOUS` warning.
  - **2D render stress** on the actual pixels at the frames of walk, run, wave and point where the joints bend most: joint rings at 90% of the limb half-width, and bone lines between joints, are fully covered.
  - **3D render stress** (Blender) for run (side view) and wave (front view): bent knees and elbows keep their outer side filled (outer depth ≥ 0.5 × limb half-width), and bone lines are covered.
- **`examples/continuity-proof/run.ts <label>`** renders the stress sheets and pixel and analysis checks above for both characters. `before` ran on the original assets (taken from git) and `after` on the new ones.
- All suites pass: core 123 tests, MCP over stdio 16 tests.

## 5. Limitations that remain

- **2D is still layered rigid parts, not mesh deformation.** Joints stay closed through overlap: capsules plus the engine's coverage check. Limbs do not bend or bulge like skin. Very stylised or large-angle poses beyond a character's motion ranges are not covered; the analysis uses the ranges the character's own motions and expressions use. New motions extend the ranges automatically at the next import.
- **Linear-blend skinning** (3D) thins the outer side of strongly bent elbows and knees. This is the standard volume loss: continuous, but not anatomically perfect. The check requires the outer side to keep at least half the limb width; running reaches about 0.64. There are no corrective shapes or dual-quaternion skinning.
- **The pixel stress checks** sample specific joints and frames (the most-bent frame of each action). The engine-level analyses are the general guarantee: skin weights for 3D, the angle sweep for 2D.
- **Side-view art:** Pip's near-arm wave still passes in front of the face. That is an artwork and pose choice of this simple test character, not a joint gap.
- **Third-party characters:** the engine now *detects* rigid or disconnected rigs and marks them not production-ready. It does not repair them; packages must provide skin weights (3D) or overlapping joint caps (2D).
