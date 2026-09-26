/**
 * Interaction definitions: reusable, data-only descriptions of multi-character interactions.
 *
 * A definition says WHO takes part (roles and what each needs), HOW the actors are placed
 * (alignment), WHEN things happen (phases as fractions of the interaction), WHERE the hands go
 * (targets computed from the actors' own dimensions, so different sizes adapt), which body parts
 * it drives (effectors), optional reactions (moves) and an optional object transfer. The runtime
 * turns an applied definition into ordinary character plan actions (approach walk, turn, hold),
 * per-frame arm targets (two-bone IK) and prop copies, all compiled into the canonical timeline.
 *
 * Built-in definitions live below; custom ones (same schema) are stored per workspace
 * (interaction_define) without code changes.
 */
import crypto from "node:crypto";
import { z } from "zod";

const ID_RE = /^[A-Za-z_][A-Za-z0-9_\-.]*$/;
const Id = z.string().regex(ID_RE, "id must start with a letter or _ and contain only letters, digits, _ - .");
const num = () => z.number();

/** Standard phase names (definitions may use others; `approach` is where the actors get into place). */
export const PHASES = ["approach", "reach", "contact", "motion", "release", "return"] as const;

const HeightSpec = z
  .object({
    shoulder: num().optional().describe("x shoulder height (average of the actors for shared targets, the partner's for partner targets)."),
    reach: num().optional().describe("+ x arm reach (the shorter arm of the actors) - e.g. -0.45 = a bit below the shoulders."),
    height: num().optional().describe("+ x body height."),
  })
  .strict();
export type HeightSpec = z.output<typeof HeightSpec>;

const Shake = z
  .object({
    phase: z.string().describe("Phase during which the target oscillates vertically."),
    amplitude: num().min(0).max(0.2).describe("Fraction of the average body height."),
    frequency: num().gt(0).max(10).describe("Hz."),
  })
  .strict();

export const TargetSpecSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("between"),
      height: HeightSpec,
      along: z.union([z.literal("reach"), num().min(0).max(1)]).default("reach").describe("Where on the line between the actors: 'reach' = split by arm reach (different sizes), or a fraction from the first role."),
      shake: Shake.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("partner"),
      of: Id.describe("Role whose body the target is on."),
      height: HeightSpec,
      forward: num().default(0).describe("x that actor's height along its facing direction (negative = behind: its back)."),
      lateral: num().default(0).describe("3D: x its height toward its LEFT side (negative = its right). Ignored in 2D."),
      heightFrom: z.enum(["partner", "both"]).default("partner").describe("Whose shoulders/height the height spec uses: the partner's, or both actors' average (e.g. a hug between different sizes)."),
    })
    .strict(),
]);
export type TargetSpec = z.output<typeof TargetSpecSchema>;

export const InteractionDefinitionSchema = z
  .object({
    id: Id,
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.number().int().min(1).default(1),
    roles: z
      .array(
        z
          .object({
            name: Id,
            description: z.string().optional(),
            requires: z.object({ actions: z.array(z.string()).default([]), sockets: z.array(z.string()).default([]) }).strict().default({ actions: [], sockets: [] }),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    duration: z.object({ default: num().gt(0), min: num().gt(0).default(0.5) }).strict(),
    params: z
      .record(z.string(), z.object({ type: z.enum(["string", "number"]), required: z.boolean().default(false), description: z.string().optional() }).strict())
      .default({}),
    alignment: z
      .object({
        mode: z.enum(["face_to_face", "none"]).default("face_to_face"),
        distance: z
          .object({
            reach: num().gt(0).max(1).default(0.9).describe("Fraction of full arm reach used at the shared target (1 = arms fully stretched)."),
            roles: z.array(Id).optional().describe("Roles whose reach toward the shared target sets the distance (default: roles with a 'between' target)."),
            height: num().default(0).describe("+ x average body height (e.g. body depth for a hug or push). The distance is then capped so every hand with a 'partner' target can reach it."),
          })
          .strict()
          .default({ reach: 0.9, height: 0 }),
        height: HeightSpec.optional().describe("Height of the shared target used for the distance (default: the first 'between' target's)."),
        anchor: z.enum(["first", "second", "midpoint"]).default("second").describe("Who stays in place: the other actor(s) walk into position during the approach phase."),
      })
      .strict()
      .default({ mode: "face_to_face", distance: { reach: 0.9, height: 0 }, anchor: "second" }),
    phases: z.array(z.object({ name: Id, end: num().gt(0).max(1).describe("Phase end as a fraction of the interaction duration.") }).strict()).min(1),
    targets: z.record(Id, TargetSpecSchema).default({}),
    effectors: z
      .array(
        z
          .object({
            role: Id,
            hand: z.enum(["right", "left", "object", "param"]).describe("'object' = the hand holding params.object; 'param' = params.hand (default right)."),
            target: Id,
            from: Id.describe("Phase during which the arm moves to the target (weight ramps in)."),
            until: Id.describe("Phase from which the arm returns (weight ramps out until the end)."),
            handPose: z.string().optional().describe("2D: hand art (character asset name) while reaching, e.g. hand_open."),
          })
          .strict(),
      )
      .default([]),
    moves: z
      .array(z.object({ role: Id, phase: Id, back: num().gt(0).max(2).describe("Steps back by x its height, keeping its facing.") }).strict())
      .default([]),
    transfer: z.object({ from: Id, to: Id, at: Id.describe("The object changes hands at the START of this phase.") }).strict().optional(),
  })
  .strict()
  .superRefine((d, cx) => {
    const roles = new Set(d.roles.map((r) => r.name));
    const phases = d.phases.map((p) => p.name);
    const add = (path: (string | number)[], message: string) => cx.addIssue({ code: "custom", path, message });
    d.phases.forEach((p, i) => {
      if (i > 0 && p.end <= d.phases[i - 1].end) add(["phases", i, "end"], "phase ends must increase");
    });
    if (d.phases[d.phases.length - 1].end !== 1) add(["phases"], "the last phase must end at 1");
    if (new Set(phases).size !== phases.length) add(["phases"], "phase names must be unique");
    const role = (r: string, path: (string | number)[]) => roles.has(r) || add(path, `unknown role "${r}"`);
    const phase = (p: string, path: (string | number)[]) => phases.includes(p) || add(path, `unknown phase "${p}"`);
    for (const [k, t] of Object.entries(d.targets)) {
      if (t.kind === "partner") role(t.of, ["targets", k, "of"]);
      if (t.kind === "between" && t.shake) phase(t.shake.phase, ["targets", k, "shake", "phase"]);
    }
    d.effectors.forEach((e, i) => {
      role(e.role, ["effectors", i, "role"]);
      if (!d.targets[e.target]) add(["effectors", i, "target"], `unknown target "${e.target}"`);
      phase(e.from, ["effectors", i, "from"]);
      phase(e.until, ["effectors", i, "until"]);
      if (phases.indexOf(e.until) <= phases.indexOf(e.from)) add(["effectors", i, "until"], "until must be a later phase than from");
      if (e.hand === "object" && !d.transfer) add(["effectors", i, "hand"], "hand 'object' needs a transfer");
    });
    d.moves.forEach((m, i) => {
      role(m.role, ["moves", i, "role"]);
      phase(m.phase, ["moves", i, "phase"]);
    });
    if (d.transfer) {
      role(d.transfer.from, ["transfer", "from"]);
      role(d.transfer.to, ["transfer", "to"]);
      phase(d.transfer.at, ["transfer", "at"]);
      if (d.transfer.from === d.transfer.to) add(["transfer"], "from and to must differ");
    }
    for (const r of d.alignment.distance.roles ?? []) role(r, ["alignment", "distance", "roles"]);
    if (d.alignment.mode === "face_to_face" && d.roles.length !== 2) add(["alignment", "mode"], "face_to_face needs exactly 2 roles");
  });
export type InteractionDefinition = z.output<typeof InteractionDefinitionSchema>;

export const interactionSha = (d: InteractionDefinition) => crypto.createHash("sha256").update(JSON.stringify(d)).digest("hex");

// ---- built-in library -------------------------------------------------------------------------

const WALK = { actions: ["walk"], sockets: [] as string[] };
const STAY = { actions: [] as string[], sockets: [] as string[] };

const raw: unknown[] = [
  {
    id: "handshake",
    name: "Handshake",
    description: "Two characters face each other, the first walks up to the second, both reach with their right hands, shake, release and return to rest.",
    roles: [
      { name: "a", description: "Approaches (unless anchor says otherwise).", requires: WALK },
      { name: "b", description: "Waits and receives the handshake.", requires: STAY },
    ],
    duration: { default: 3, min: 1.2 },
    alignment: { mode: "face_to_face", distance: { reach: 0.9 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.3 },
      { name: "reach", end: 0.45 },
      { name: "contact", end: 0.52 },
      { name: "motion", end: 0.78 },
      { name: "release", end: 0.88 },
      { name: "return", end: 1 },
    ],
    targets: { grip: { kind: "between", height: { shoulder: 1, reach: -0.45 }, along: "reach", shake: { phase: "motion", amplitude: 0.022, frequency: 2.5 } } },
    effectors: [
      { role: "a", hand: "param", target: "grip", from: "reach", until: "release" },
      { role: "b", hand: "param", target: "grip", from: "reach", until: "release" },
    ],
  },
  {
    id: "high_five",
    name: "High five",
    description: "Two characters face each other and slap raised open hands above head height.",
    roles: [
      { name: "a", requires: WALK },
      { name: "b", requires: STAY },
    ],
    duration: { default: 2, min: 1 },
    alignment: { mode: "face_to_face", distance: { reach: 0.92 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.3 },
      { name: "reach", end: 0.55 },
      { name: "contact", end: 0.62 },
      { name: "release", end: 0.75 },
      { name: "return", end: 1 },
    ],
    targets: { slap: { kind: "between", height: { shoulder: 1, reach: 0.55 }, along: "reach" } },
    effectors: [
      { role: "a", hand: "param", target: "slap", from: "reach", until: "release", handPose: "hand_open" },
      { role: "b", hand: "param", target: "slap", from: "reach", until: "release", handPose: "hand_open" },
    ],
  },
  {
    id: "hug",
    name: "Hug",
    description: "Two characters step close and wrap both arms around each other's back, hold, then let go.",
    roles: [
      { name: "a", requires: WALK },
      { name: "b", requires: STAY },
    ],
    duration: { default: 3.5, min: 1.5 },
    alignment: { mode: "face_to_face", distance: { reach: 0.9, roles: [], height: 0.2 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.25 },
      { name: "reach", end: 0.42 },
      { name: "contact", end: 0.78 },
      { name: "release", end: 0.88 },
      { name: "return", end: 1 },
    ],
    targets: {
      a_right: { kind: "partner", of: "b", height: { shoulder: 0.88 }, heightFrom: "both", forward: -0.025, lateral: 0.07 },
      a_left: { kind: "partner", of: "b", height: { shoulder: 0.88 }, heightFrom: "both", forward: -0.025, lateral: -0.07 },
      b_right: { kind: "partner", of: "a", height: { shoulder: 0.82 }, heightFrom: "both", forward: -0.025, lateral: 0.07 },
      b_left: { kind: "partner", of: "a", height: { shoulder: 0.82 }, heightFrom: "both", forward: -0.025, lateral: -0.07 },
    },
    effectors: [
      { role: "a", hand: "right", target: "a_right", from: "reach", until: "release" },
      { role: "a", hand: "left", target: "a_left", from: "reach", until: "release" },
      { role: "b", hand: "right", target: "b_right", from: "reach", until: "release" },
      { role: "b", hand: "left", target: "b_left", from: "reach", until: "release" },
    ],
  },
  {
    id: "give_object",
    name: "Give object",
    description: "The giver walks up and hands a prop it holds (params.object) to the receiver: both hands meet, the prop changes owner once, and the receiver keeps it.",
    roles: [
      { name: "giver", description: "Holds params.object (own prop or received earlier).", requires: WALK },
      { name: "receiver", requires: STAY },
    ],
    duration: { default: 3, min: 1.2 },
    params: { object: { type: "string", required: true, description: "Prop id the giver holds." } },
    alignment: { mode: "face_to_face", distance: { reach: 0.88 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.3 },
      { name: "reach", end: 0.5 },
      { name: "contact", end: 0.64 },
      { name: "release", end: 0.78 },
      { name: "return", end: 1 },
    ],
    targets: { handover: { kind: "between", height: { shoulder: 1, reach: -0.4 }, along: "reach" } },
    effectors: [
      { role: "giver", hand: "object", target: "handover", from: "reach", until: "release" },
      { role: "receiver", hand: "param", target: "handover", from: "reach", until: "release" },
    ],
    transfer: { from: "giver", to: "receiver", at: "release" },
  },
  {
    id: "receive_object",
    name: "Receive object",
    description: "Same as give_object seen from the receiver: the receiver (first actor) walks up and takes params.object from the giver (second actor).",
    roles: [
      { name: "receiver", requires: WALK },
      { name: "giver", description: "Holds params.object.", requires: STAY },
    ],
    duration: { default: 3, min: 1.2 },
    params: { object: { type: "string", required: true, description: "Prop id the giver holds." } },
    alignment: { mode: "face_to_face", distance: { reach: 0.88 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.3 },
      { name: "reach", end: 0.5 },
      { name: "contact", end: 0.64 },
      { name: "release", end: 0.78 },
      { name: "return", end: 1 },
    ],
    targets: { handover: { kind: "between", height: { shoulder: 1, reach: -0.4 }, along: "reach" } },
    effectors: [
      { role: "receiver", hand: "param", target: "handover", from: "reach", until: "release" },
      { role: "giver", hand: "object", target: "handover", from: "reach", until: "release" },
    ],
    transfer: { from: "giver", to: "receiver", at: "release" },
  },
  {
    id: "push",
    name: "Push",
    description: "The pusher walks up and shoves the other character's chest with both hands; the hands let go as the pushed character steps back (keeping its facing), then both return to rest. No physics.",
    roles: [
      { name: "pusher", requires: WALK },
      { name: "pushed", description: "Steps back.", requires: WALK },
    ],
    duration: { default: 2.5, min: 1.2 },
    alignment: { mode: "face_to_face", distance: { reach: 0.85, roles: ["pusher"], height: 0.07 }, height: { shoulder: 0.85 }, anchor: "second" },
    phases: [
      { name: "approach", end: 0.35 },
      { name: "reach", end: 0.5 },
      { name: "contact", end: 0.55 },
      { name: "motion", end: 0.75 },
      { name: "release", end: 0.85 },
      { name: "return", end: 1 },
    ],
    targets: {
      chest_r: { kind: "partner", of: "pushed", height: { shoulder: 0.85 }, forward: 0.07, lateral: 0.06 },
      chest_l: { kind: "partner", of: "pushed", height: { shoulder: 0.85 }, forward: 0.07, lateral: -0.06 },
    },
    effectors: [
      { role: "pusher", hand: "right", target: "chest_r", from: "reach", until: "motion" },
      { role: "pusher", hand: "left", target: "chest_l", from: "reach", until: "motion" },
    ],
    moves: [{ role: "pushed", phase: "motion", back: 0.22 }],
  },
];

export const BUILTIN_INTERACTIONS: Record<string, InteractionDefinition> = Object.fromEntries(
  raw.map((r) => {
    const d = InteractionDefinitionSchema.parse(r);
    return [d.id, d];
  }),
);
