/**
 * What a prepared character can do, derived from its definition: actions (with channel, the
 * parameters they take and what they map to), expressions, mouth shapes, eyes, sockets for props,
 * motions/clips, directions and the composition rules. Agents read this instead of guessing.
 */
import { characterActions, KIND_CHANNEL } from "./plan.js";
import { VISEMES, type CharacterDefinition } from "./schema.js";

const PARAMS: Record<string, string[]> = {
  locomotion: ["start", "duration|end", "direction", "to", "distance", "speed"],
  idle: ["start", "duration|end"],
  gesture: ["start", "duration|end"],
  look: ["start", "duration|end", "direction"],
  expression: ["start", "duration|end", "intensity", "expression (only for action 'expression')"],
  speech: ["start", "duration|end (default: speech length)", "speech (timing id or inline)", "intensity", "seed"],
  blink: ["start", "duration|end", "count", "interval", "seed"],
  turn: ["start", "direction", "duration (turn time)"],
};

export const COMPOSITION_RULES = [
  "locomotion (walk, run, idle, ...): one at a time; overlapping locomotion actions are rejected (ACTION_CONFLICT). Gaps play the idle motion.",
  "gestures (wave, point, look, ...): each controls some body parts; two gestures using the same part at the same time are rejected. A 2D gesture overrides locomotion only on its parts (walk + wave works). A 3D gesture plays a full-body clip, so it cannot overlap walk/run.",
  "expression (smile, sad, surprised, ...): one at a time; overlapping expressions are rejected. Neutral when none.",
  "talk: one at a time. Combines with any expression (expression-specific mouth shapes when the character has them), with gestures, locomotion and blinks.",
  "blink: never conflicts; overlapping blinks merge. autoBlink adds seeded background blinks.",
  "turn: walk/run already face their direction; a turn during walk/run is rejected.",
  "Transitions blend over the character's blend time; everything is deterministic (seeded).",
];

export function describeCharacter(def: CharacterDefinition, sha?: string) {
  const actions = characterActions(def);
  const directions: Record<string, string[]> = {};
  const actionList = Object.entries(actions)
    .map(([name, a]) => {
      const dirs =
        a.kind === "locomotion" ? (def.kind === "2d" ? ["left", "right"] : ["left", "right", "camera", "away"]) : a.kind === "turn" ? (def.kind === "2d" ? ["left", "right"] : ["left", "right", "camera", "away"]) : a.kind === "look" ? ["forward", ...Object.keys(a.motions ?? {})] : undefined;
      if (dirs) directions[name] = dirs;
      return {
        name,
        kind: a.kind,
        channel: KIND_CHANNEL[a.kind],
        params: PARAMS[a.kind],
        ...(dirs ? { directions: dirs } : {}),
        ...(a.speed ? { defaultSpeed: a.speed, speedUnit: def.kind === "2d" ? "px/s at scale 1" : "m/s" } : {}),
        ...(a.expression ? { expression: a.expression } : {}),
        ...(a.motion ? { motion: a.motion } : {}),
        ...(a.clip ? { clip: a.clip } : {}),
        ...(a.claims ? { parts: a.claims } : {}),
        ...(a.description ? { description: a.description } : {}),
      };
    })
    .sort((x, y) => x.channel.localeCompare(y.channel) || x.name.localeCompare(y.name));
  const mouthSets = def.mouth ? Object.fromEntries(Object.entries(def.mouth.sets).map(([k, v]) => [k, Object.keys(v)])) : {};
  return {
    characterId: def.id,
    name: def.name ?? def.id,
    kind: def.kind,
    version: def.version,
    ...(sha ? { sha256: sha } : {}),
    description: def.description ?? null,
    actions: actionList,
    expressions: ["neutral", ...Object.keys(def.expressions)],
    speech: def.mouth
      ? {
          talk: true,
          visemes: [...VISEMES],
          mouthSets,
          note: "Unsupported shapes fall back (FV->MBP->rest, L->E, U->O, O->AI, E->AI). Without timing: deterministic generic talking.",
          timingInput: "speech: {audio?, duration?, visemes?:[{viseme,start,end}] | characters?:[{char,start,end}] | words?:[{word,start,end}], text?}",
        }
      : { talk: false },
    blink: !!def.eyes,
    sockets: def.kind === "2d" ? Object.fromEntries(Object.entries(def.sockets).map(([k, v]) => [k, `${v.part}${v.point ? ":" + v.point : ""}`])) : def.sockets ?? {},
    socketsNote: def.kind === "3d" ? "Plus every socket detected on the model (rightHand, leftHand, head, ...: see asset_inspect of the model asset)." : undefined,
    ...(def.kind === "2d"
      ? { motions: Object.keys(def.motions), parts: def.rig.parts.map((p) => p.id), facing: def.rig.facing, heightPx: def.rig.height ?? null, units: "canvas pixels; x/y = feet position" }
      : { model: def.model, clips: [...new Set(Object.values(def.actions).map((a) => a.clip).filter(Boolean))], units: "metres; position = feet; facing camera = +z" }),
    defaults: def.defaults,
    compositionRules: COMPOSITION_RULES,
    compatible: [
      ["walk", "talk"],
      ["walk", "smile"],
      ["talk", "smile"],
      ["talk", "blink"],
      ["idle", "talk", "blink"],
      ...(def.kind === "2d" ? [["walk", "wave"]] : []),
    ].filter((combo) => combo.every((a) => actions[a])),
  };
}
