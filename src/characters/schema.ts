/**
 * Character Runtime schemas.
 *
 * - CharacterDefinition: a PREPARED character (made once, reused everywhere): its rig/model, the
 *   reusable motions/clips, expressions, mouth (viseme) states, eyes, sockets and the actions it
 *   supports. 2D and 3D characters share the action vocabulary; only the implementation differs.
 * - CharacterInstance: a character placed in a scene, with its editable high-level action list.
 *   It lives in the scene document (`characters[]`) and is compiled by the runtime into ordinary
 *   layers/objects and timeline tracks (marked with `owner`), so the canonical timeline stays the
 *   single source for rendering, measuring and inspection.
 * - SpeechTiming: provider-neutral speech timing (visemes, character or word alignment, or
 *   nothing: then a deterministic generic talk animation is used).
 *
 * This module has no dependency on the scene schemas so they can embed CharacterInstance.
 */
import { z } from "zod";

const ID_RE = /^[A-Za-z_][A-Za-z0-9_\-.]*$/;
const Id = z.string().regex(ID_RE, "id must start with a letter or _ and contain only letters, digits, _ - .");
const num = () => z.number();

// ---- speech -----------------------------------------------------------------------------------

/**
 * Normalised mouth shapes (a compact Preston-Blair-style set). Providers' alignments (characters,
 * words, phonemes, visemes) are mapped onto these; characters map these onto their own mouth art
 * or morph targets.
 */
export const VISEMES = ["rest", "MBP", "AI", "E", "O", "U", "FV", "L"] as const;
export type Viseme = (typeof VISEMES)[number];
export const VisemeSchema = z.enum(VISEMES);

const TimedSpan = { start: num().min(0).describe("Seconds from the start of the speech."), end: num().min(0).describe("Seconds from the start of the speech.") };

export const SpeechTimingSchema = z
  .object({
    audio: Id.optional().describe("Audio asset id of the voice line; added to the scene audio at the talk action's start."),
    volume: num().min(0).max(10).optional(),
    text: z.string().max(20000).optional().describe("Transcript (informational; used for the fallback when no timing is given)."),
    duration: num().gt(0).optional().describe("Speech length in seconds (default: last timed item, or the action duration)."),
    visemes: z.array(z.object({ viseme: VisemeSchema, ...TimedSpan }).strict()).optional().describe("Most precise: explicit mouth shapes."),
    characters: z
      .array(z.object({ char: z.string().min(1).max(4), ...TimedSpan }).strict())
      .optional()
      .describe("Character-level alignment (as many TTS providers return): each character with start/end seconds."),
    words: z.array(z.object({ word: z.string().min(1).max(100), ...TimedSpan }).strict()).optional().describe("Word-level alignment."),
  })
  .strict();
export type SpeechTiming = z.output<typeof SpeechTimingSchema>;

// ---- scene-side: instances and actions ---------------------------------------------------------

export const DIRECTIONS = ["left", "right", "camera", "away", "up", "down", "forward"] as const;

export const CharacterActionSchema = z
  .object({
    id: Id.optional().describe("Stable action id (auto-assigned: a1, a2, ...). Use it to edit/remove the action later."),
    action: z.string().min(1).describe("Action name: walk, run, idle, talk, smile (or any expression), blink, wave, point, turn, look, ... (see character_inspect)."),
    start: num().min(0).describe("Start time in seconds."),
    duration: num().gt(0).optional().describe("Length in seconds (or give `end`). Some actions derive it: walk/run `to`/`distance`, talk from speech timing, blink/turn are short by default."),
    end: num().gt(0).optional().describe("End time in seconds (alternative to duration)."),
    direction: z.enum(DIRECTIONS).optional().describe("walk/run: left | right (2D and 3D), camera | away (3D: toward/away from the camera). turn: left | right | camera | away. look: up | down | forward."),
    to: z
      .object({ x: num(), y: num().optional(), z: num().optional() })
      .strict()
      .optional()
      .describe("walk/run target: 2D canvas pixels {x, y?}; 3D metres {x, z?}. Direction and facing follow from it."),
    distance: num().gt(0).optional().describe("walk/run distance (2D px, 3D m) instead of duration/to."),
    speed: num().gt(0).optional().describe("walk/run speed (2D px/s, 3D m/s); default from the character."),
    expression: z.string().optional().describe("For action 'expression': the expression name (smile, sad, surprised, neutral, ...)."),
    speech: z.union([Id, SpeechTimingSchema]).optional().describe("talk: speech timing id (speech_timing_save) or inline timing. Omit for generic talking."),
    speechId: Id.optional().describe("(set by the runtime) id of the saved timing that `speech` was resolved from."),
    intensity: num().min(0).max(1).optional().describe("Strength of an expression/talk (default 1)."),
    count: z.number().int().min(1).max(100).optional().describe("blink: number of blinks spread over the duration (default 1)."),
    interval: num().gt(0).optional().describe("blink: blink every N seconds over the duration (seeded jitter)."),
    seed: z.number().int().optional().describe("Seed for deterministic variation (generic talk, blink jitter)."),
  })
  .strict();
export type CharacterAction = z.output<typeof CharacterActionSchema>;

const Vec3 = z.object({ x: num(), y: num(), z: num() }).strict();

export const CharacterPropSchema = z
  .object({
    id: Id.describe("Prop id; the generated layer/object is <instance>.<id>."),
    asset: Id.describe("Image asset (2D) or model asset (3D)."),
    socket: z.string().min(1).describe("Character socket: rightHand, leftHand, head, ... (see character_inspect)."),
    x: num().optional().describe("2D: offset in px from the socket point (in the hand's rotated frame)."),
    y: num().optional(),
    rotation: num().optional().describe("2D: degrees relative to the hand."),
    scale: num().gt(0).optional(),
    z: num().optional().describe("2D: draw order offset relative to the socket part (default +0.5: in front of the hand)."),
    position: Vec3.partial().optional().describe("3D: offset in metres (character axes at rest pose, anchored at the joint)."),
    rotation3: Vec3.partial().optional().describe("3D: rotation offset in degrees."),
    follow: z.enum(["full", "position"]).optional().describe("3D: follow the bone fully (default) or only its position (prop stays upright)."),
    visibleFrom: num().min(0).optional().describe("Seconds: prop appears at this time."),
    visibleUntil: num().min(0).optional().describe("Seconds: prop disappears at this time."),
  })
  .strict();
export type CharacterProp = z.output<typeof CharacterPropSchema>;

export const CharacterInstanceSchema = z
  .object({
    id: Id.describe("Instance id in this scene; generated layers/objects are <id> (root) and <id>.<part>."),
    character: Id.describe("Prepared character id (character_list)."),
    definitionSha: z.string().optional().describe("(set by the runtime) hash of the definition the instance was compiled with."),
    x: num().optional().describe("2D: canvas x of the character's feet (root)."),
    y: num().optional().describe("2D: canvas y of the character's feet (ground line)."),
    position: Vec3.optional().describe("3D: world position (metres) of the feet."),
    scale: num().gt(0).optional().describe("Uniform scale (default 1)."),
    facing: z.enum(["left", "right", "camera", "away"]).optional().describe("Initial facing (default: the character's default)."),
    z: num().optional().describe("2D: base draw order of the character (default 10); its parts draw at z + small offsets."),
    autoBlink: z
      .union([z.boolean(), z.object({ interval: num().gt(0).optional(), seed: z.number().int().optional() }).strict()])
      .optional()
      .describe("Deterministic background blinking (seeded). Default true when the character can blink."),
    props: z.array(CharacterPropSchema).optional(),
    actions: z.array(CharacterActionSchema).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CharacterInstance = z.output<typeof CharacterInstanceSchema>;

// ---- character definitions (prepared packages) --------------------------------------------------

/** [time in seconds, value] keys; numeric values are OFFSETS added to the rest pose. */
const Keys = z.array(z.tuple([num().min(0), num()])).min(1);

export const MotionSchema = z
  .object({
    duration: num().gt(0).describe("Cycle length in seconds."),
    loop: z.boolean().default(true).describe("Loop the cycle; false holds the last pose (e.g. point)."),
    tracks: z.record(z.string().regex(/^[A-Za-z_][\w\-.]*\.(rotation|x|y|scaleX|scaleY|opacity)$/, "track key is <part>.<rotation|x|y|scaleX|scaleY|opacity>"), Keys).default({}),
    assets: z.record(z.string(), z.string()).optional().describe("Part -> asset name swaps while the motion is active."),
    interpolation: z.enum(["linear", "smooth"]).default("smooth"),
    blend: num().min(0).optional().describe("Blend in/out seconds (default: character default)."),
  })
  .strict();
export type Motion = z.output<typeof MotionSchema>;

export const PartSchema = z
  .object({
    id: Id,
    asset: z.string().optional().describe("Asset name (key of `assets`)."),
    fill: z.string().optional(),
    parent: Id.nullable().optional().describe("Parent part id (null/omitted: the character root)."),
    parentPoint: Id.optional(),
    x: num().default(0),
    y: num().default(0),
    width: num().min(0).optional(),
    height: num().min(0).optional(),
    anchorX: num().min(0).max(1).default(0.5),
    anchorY: num().min(0).max(1).default(0.5),
    rotation: num().default(0),
    scaleX: num().default(1),
    scaleY: num().default(1),
    opacity: num().min(0).max(1).default(1),
    visible: z.boolean().default(true),
    z: num().default(0).describe("Draw order within the character (small numbers; added to the instance z / 100)."),
    attachmentPoints: z.record(Id, z.object({ x: num(), y: num() }).strict()).optional(),
  })
  .strict();

const ActionKinds = ["locomotion", "idle", "gesture", "look", "expression", "speech", "blink", "turn"] as const;
export const ActionDefSchema = z
  .object({
    kind: z.enum(ActionKinds),
    motion: z.string().optional().describe("2D: motion preset name."),
    motions: z.record(z.string(), z.string()).optional().describe("2D look: direction -> motion preset."),
    clip: z.string().optional().describe("3D: animation clip name."),
    speed: num().gt(0).optional().describe("locomotion default speed (2D px/s, 3D m/s)."),
    expression: z.string().optional().describe("expression actions: which expression."),
    claims: z.array(z.string()).optional().describe("2D gesture/look: parts it controls (default: the parts its motion animates)."),
    description: z.string().optional(),
  })
  .strict();
export type ActionDef = z.output<typeof ActionDefSchema>;

const Defaults = z
  .object({
    blend: num().min(0).default(0.2).describe("Seconds of blend in/out for motions, gestures and expressions."),
    turnTime: num().min(0).default(0.2).describe("Seconds a turn takes."),
    blinkDuration: num().gt(0).default(0.15),
    autoBlinkInterval: num().gt(0).default(3.5),
    facing: z.enum(["left", "right", "camera", "away"]).optional(),
  })
  .strict();

const Common = {
  id: Id,
  name: z.string().optional(),
  version: z.number().int().min(1).default(1),
  description: z.string().optional(),
  actions: z.record(z.string(), ActionDefSchema).default({}),
  defaults: Defaults.default({ blend: 0.2, turnTime: 0.2, blinkDuration: 0.15, autoBlinkInterval: 3.5 }),
};

export const Character2DSchema = z
  .object({
    ...Common,
    kind: z.literal("2d"),
    /** Asset name -> file inside the package (on disk) or workspace asset id (after import). */
    assets: z.record(z.string(), z.string()),
    rig: z
      .object({
        facing: z.enum(["left", "right"]).default("right").describe("Direction the artwork faces unmirrored."),
        height: num().gt(0).optional().describe("Approximate character height in px at scale 1 (informational)."),
        parts: z.array(PartSchema).min(1),
      })
      .strict(),
    sockets: z.record(z.string(), z.object({ part: Id, point: Id.optional() }).strict()).default({}),
    motions: z.record(z.string(), MotionSchema).default({}),
    expressions: z
      .record(z.string(), z.object({ parts: z.record(z.string(), z.object({ asset: z.string().optional(), x: num().optional(), y: num().optional(), rotation: num().optional() }).strict()).default({}), mouthSet: z.string().optional() }).strict())
      .default({}),
    mouth: z.object({ part: Id, sets: z.record(z.string(), z.partialRecord(VisemeSchema, z.string())) }).strict().optional(),
    eyes: z.object({ part: Id, open: z.string(), closed: z.string() }).strict().optional(),
  })
  .strict();

const MorphWeights = z.record(z.string(), num().min(0).max(1));

export const Character3DSchema = z
  .object({
    ...Common,
    kind: z.literal("3d"),
    model: z.string().describe("Model file inside the package (on disk) or model asset id (after import)."),
    scale: num().gt(0).default(1),
    blendFrames: z.number().int().min(0).max(60).default(6).describe("Clip crossfade frames."),
    expressions: z.record(z.string(), z.object({ morphs: MorphWeights }).strict()).default({}),
    mouth: z.object({ sets: z.record(z.string(), z.partialRecord(VisemeSchema, MorphWeights)) }).strict().optional(),
    eyes: z.object({ blink: MorphWeights }).strict().optional(),
    sockets: z.record(z.string(), z.string()).optional().describe("Extra/overriding socket -> joint names (model sockets are detected automatically)."),
  })
  .strict();

export const CharacterDefinitionSchema = z.discriminatedUnion("kind", [Character2DSchema, Character3DSchema]);
export type CharacterDefinition = z.output<typeof CharacterDefinitionSchema>;
export type Character2D = z.output<typeof Character2DSchema>;
export type Character3D = z.output<typeof Character3DSchema>;
