# Test asset generation prompts

No image-generation service was available in this environment, so every asset in
`assets/originals/` was produced by `generate-assets.ts`, which draws it with Canvas 2D. The drawings
imitate what an image model returns under the contract below: a solid key colour, a clean margin,
anti-aliased edges and per-pixel noise.

The prompts are the ones to send to an image model when real generation becomes available. The
engine does **not** need to know the key colour in advance. It detects the colour from the image
border (`detectBackground`), so a prompt only has to pick a colour that contrasts with the subject.

## Foreground-object contract (Path B, solid key colour)

Every isolated-object prompt ends with this block, with `{KEY}` filled in:

> Isolated single object, the entire object fully inside the frame, not touching or cropped by any
> image edge, with at least 40 pixels of empty margin on every side. Background: one perfectly flat,
> uniform {KEY} colour filling the whole canvas: no gradient, no vignette, no texture, no floor, no
> horizon, no decorative elements. No cast shadow or reflection reaching the image border. Strong
> visual separation between object and background. Do not use {KEY} or colours close to it anywhere
> on the object. Clean, crisp, anti-aliased edges.

How to choose the key colour: pick the colour farthest (in hue) from the subject's dominant colours.

| Asset | Key colour | Why |
|---|---|---|
| counter | green `#23c43a` | wood and white marble contain no green |
| cup | blue `#14a9e7` | white/red mug. **Deliberate violation for testing:** a stripe in the key colour is enclosed by the mug (the pipeline must keep it) |
| plant | magenta `#e020c8` | green leaves and a terracotta pot: blue or green would clash |

### counter_keyed.png
> Flat 2D cartoon kitchen counter seen straight from the front, warm honey-wood lower cabinet with
> four doors and cream-coloured bar handles, a white marble worktop slab with subtle grey veins,
> dark toe-kick at the bottom. Orthographic front view, no perspective. Clean vector illustration style,
> thin dark-brown outlines. + contract ({KEY} = bright green #23c43a)

### cup_keyed.png
> Flat 2D cartoon coffee mug, front view, handle on the right, white ceramic with a red rim and a red
> heart, a horizontal sky-blue band across the middle, dark coffee visible at the top. Thin grey
> outline. + contract ({KEY} = sky blue #14a9e7)
>
> (The blue band intentionally matches the key colour, to prove that flood-fill removal keeps
> enclosed same-colour regions. A real prompt would avoid this.)

### plant_keyed.png
> Flat 2D cartoon potted plant: a terracotta pot with a darker rim, many long pointed leaves in
> several greens fanning upward and outward, each with a darker central vein. + contract
> ({KEY} = magenta #e020c8)

## Native-transparency assets (Path A)

When a provider can return real alpha, ask for it explicitly and skip colour keying:

> ... on a fully transparent background (PNG with alpha channel). No background colour, no shadow,
> the object not touching the image edges.

Character parts must share one style, and each part must be drawn separately, in a neutral pose,
and aligned so its joint sits in a predictable place:

| Asset | Prompt core | Joint / pivot |
|---|---|---|
| torso | teal long-sleeve shirt torso with a cream apron and navy waistband, no arms, no head, front view | hips (bottom centre); attachment points: neck, shoulders |
| head | cartoon woman's head, brown bob haircut, round face, blush cheeks, small nose, **no eyes and no mouth** (separate layers), short neck stub at the bottom | neck base |
| upper arm (L/R) | teal sleeve segment, vertical, rounded ends | shoulder (top); elbow point near the bottom |
| forearm (L/R) | bare skin forearm with a teal cuff at the top, vertical | elbow (top); wrist point near the bottom |
| hand (L/R) | simple cartoon hand, palm facing the viewer, thumb out | wrist (top); `grip` point in the palm |
| leg (L/R) | navy trouser leg with a dark shoe, vertical | hip (top); `foot` point at the sole |
| eyes_open / eyes_closed | pair of cartoon eyes with brows, blue irises / closed arcs | centre |
| mouth_rest / MBP / A / O / E | a mouth shape for the viseme: rest smile / lips pressed / open "ah" with teeth and tongue / round "oh" / wide "ee" | centre |
| window_frame | white wooden window frame with a cross mullion and a sill, the glass area fully transparent | `opening_top_left` / `opening_bottom_right` points |
| cloud, steam | soft white cloud / three wavy steam strokes, semi-transparent | centre / bottom |

`manifest.json` stores each asset's pivot and attachment points in **original pixel coordinates**.
The pipeline converts them to normalised coordinates of the trimmed image
(`attachmentPointsPx` → `asset-metadata.json` → scene `attachmentPoints`).
