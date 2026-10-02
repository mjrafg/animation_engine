import type { SpeechTiming } from "../../src/characters/schema.js";
export interface ElevenLabsAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}
/** Provider-specific field names stay out of the engine. */
export function elevenLabsToSpeechTiming(response: {
  alignment?: ElevenLabsAlignment;
  normalized_alignment?: ElevenLabsAlignment;
}): SpeechTiming {
  const a = response.normalized_alignment ?? response.alignment;
  if (
    !a ||
    !a.characters.length ||
    a.characters.length !== a.character_start_times_seconds.length ||
    a.characters.length !== a.character_end_times_seconds.length
  )
    throw new Error("Missing or inconsistent ElevenLabs alignment");
  const characters = a.characters.map((char, i) => ({
    char,
    start: a.character_start_times_seconds[i],
    end: a.character_end_times_seconds[i],
  }));
  if (
    characters.some(
      (c, i) =>
        !Number.isFinite(c.start) ||
        !Number.isFinite(c.end) ||
        c.start < 0 ||
        c.end < c.start ||
        (i > 0 && c.start < characters[i - 1].start),
    )
  )
    throw new Error("Invalid ElevenLabs alignment times");
  return { text: a.characters.join(""), duration: Math.max(...characters.map((c) => c.end)), characters };
}
