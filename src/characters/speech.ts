/**
 * Speech -> mouth shapes, provider-neutral and deterministic.
 *
 * Priority: explicit `visemes` > character alignment (`characters`) > word alignment (`words`,
 * spread over each word's letters) > generic talking (seeded pseudo-random mouth cycle over the
 * duration). Output: non-overlapping viseme spans in seconds, starting at 0 (speech start).
 */
import type { SpeechTiming, Viseme } from "./schema.js";

export interface VisemeSpan {
  viseme: Viseme;
  start: number;
  end: number;
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), for per-instance seeds. */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const LETTER: Record<string, Viseme> = {};
for (const [v, letters] of Object.entries({ AI: "aihy", E: "ecgjkrsxz", O: "o", U: "uwq", MBP: "mbp", FV: "fv", L: "ltdn" }) as [Viseme, string][]) {
  for (const ch of letters) LETTER[ch] = v;
}

/** Viseme for one character of text ("rest" for spaces/punctuation). */
export function visemeForChar(ch: string): Viseme {
  const c = ch.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")[0] ?? "";
  return LETTER[c] ?? (/[0-9]/.test(c) ? "E" : "rest");
}

/** Merges equal neighbours and absorbs spans shorter than `minHold` seconds into their neighbour. */
function tidy(spans: VisemeSpan[], minHold: number): VisemeSpan[] {
  const out: VisemeSpan[] = [];
  for (const s of spans.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const prev = out[out.length - 1];
    if (prev && s.start < prev.end) s.start = prev.end;
    if (s.end <= s.start) continue;
    if (prev && prev.viseme === s.viseme && s.start - prev.end < 1e-6) prev.end = s.end;
    else if (prev && s.start - prev.end > 1e-6) out.push({ viseme: "rest", start: prev.end, end: s.start }, s);
    else out.push({ ...s });
  }
  // absorb very short shapes (they would flicker at video frame rates)
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (out[i].end - out[i].start >= minHold || out.length === 1) continue;
      const target = i > 0 ? i - 1 : i + 1;
      if (target < i) out[target].end = out[i].end;
      else out[target].start = out[i].start;
      out.splice(i, 1);
      changed = true;
      break;
    }
    for (let i = 1; i < out.length; i++) {
      if (out[i].viseme === out[i - 1].viseme) {
        out[i - 1].end = out[i].end;
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export interface SpeechPlan {
  source: "visemes" | "characters" | "words" | "generic";
  duration: number;
  spans: VisemeSpan[];
}

/** Length of a timing in seconds (explicit duration, else its last timed item), or undefined. */
export function speechDuration(t: SpeechTiming | undefined): number | undefined {
  if (!t) return undefined;
  if (t.duration) return t.duration;
  const ends = [...(t.visemes ?? []), ...(t.characters ?? []), ...(t.words ?? [])].map((x) => x.end);
  return ends.length ? Math.max(...ends) : undefined;
}

/**
 * Viseme spans for a talk of `duration` seconds. `minHold` is typically 1.5 video frames so that
 * no mouth shape is shorter than what the frame rate can show.
 */
export function planSpeech(t: SpeechTiming | undefined, duration: number, seed: number, minHold: number): SpeechPlan {
  if (t?.visemes?.length) {
    return { source: "visemes", duration, spans: tidy(t.visemes.map((v) => ({ viseme: v.viseme, start: v.start, end: Math.min(v.end, duration) })), minHold) };
  }
  if (t?.characters?.length) {
    return {
      source: "characters",
      duration,
      spans: tidy(t.characters.map((c) => ({ viseme: visemeForChar(c.char), start: c.start, end: Math.min(c.end, duration) })), minHold),
    };
  }
  if (t?.words?.length) {
    const spans: VisemeSpan[] = [];
    for (const w of t.words) {
      const letters = [...w.word].filter((ch) => visemeForChar(ch) !== "rest" || /\w/.test(ch));
      const n = Math.max(1, letters.length);
      const step = (w.end - w.start) / n;
      letters.forEach((ch, i) => spans.push({ viseme: visemeForChar(ch), start: w.start + i * step, end: Math.min(w.start + (i + 1) * step, duration) }));
    }
    return { source: "words", duration, spans: tidy(spans, minHold) };
  }
  // generic talking: a deterministic open/close pattern with short pauses
  const rnd = prng(seed);
  const shapes: Viseme[] = ["AI", "E", "O", "MBP", "AI", "L", "E", "U", "AI", "FV"];
  const spans: VisemeSpan[] = [];
  let tt = 0;
  let i = Math.floor(rnd() * shapes.length);
  let sinceBreak = 0;
  while (tt < duration - 0.05) {
    const len = 0.09 + rnd() * 0.09;
    let v = shapes[i++ % shapes.length];
    if (sinceBreak > 1.2 + rnd() * 1.2) {
      v = "rest";
      sinceBreak = 0;
    }
    spans.push({ viseme: v, start: tt, end: Math.min(duration, tt + (v === "rest" ? len * 2 : len)) });
    tt += v === "rest" ? len * 2 : len;
    sinceBreak += len;
  }
  return { source: "generic", duration, spans: tidy(spans, minHold) };
}

/** Fallback chain when a character lacks a viseme. */
export const VISEME_FALLBACK: Record<Viseme, Viseme | null> = {
  rest: null,
  MBP: "rest",
  FV: "MBP",
  L: "E",
  U: "O",
  O: "AI",
  E: "AI",
  AI: "rest",
};

export function resolveViseme<T>(set: Partial<Record<Viseme, T>>, v: Viseme): T | undefined {
  let cur: Viseme | null = v;
  while (cur) {
    if (set[cur] !== undefined) return set[cur];
    cur = VISEME_FALLBACK[cur];
  }
  return set.rest;
}
