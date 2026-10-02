import { z } from "zod";
import { SpeechTimingSchema, type SpeechTiming } from "../characters/schema.js";
import { EngineError } from "../errors.js";
export const TimingBlockSchema = z
  .object({
    timing: SpeechTimingSchema,
    startFrame: z.number().int().min(0),
    startOffsetMs: z.number().min(0).optional(),
    sourceIn: z.number().min(0).optional(),
    sourceOut: z.number().positive().optional(),
  })
  .strict();
export const SubtitleStyleSchema = z
  .object({
    font: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^,\r\n{}\\]+$/)
      .optional(),
    size: z.number().positive().max(500).optional(),
    outline: z.number().min(0).max(20).optional(),
    margin: z.number().int().min(0).max(4096).optional(),
    position: z.number().int().min(1).max(9).optional(),
    direction: z.enum(["auto", "rtl", "ltr"]).optional(),
  })
  .strict();
export const SubtitlesTimingOptionsSchema = z
  .object({
    fps: z.number().positive().max(240),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    maxCharacters: z.number().int().min(1).max(500).optional(),
    maxLines: z.number().int().min(1).max(2).optional(),
    minDuration: z.number().positive().optional(),
    maxDuration: z.number().positive().optional(),
    pauseThreshold: z.number().min(0).optional(),
    style: SubtitleStyleSchema.optional(),
  })
  .strict();
export type TimingBlock = z.infer<typeof TimingBlockSchema>;
export type SubtitlesTimingOptions = z.infer<typeof SubtitlesTimingOptionsSchema>;
export interface SubtitleCue {
  start: number;
  end: number;
  lines: string[];
}
export function timingWords(timing: SpeechTiming): { word: string; start: number; end: number }[] {
  if (timing.words?.length) return timing.words.map((w) => ({ ...w }));
  if (!timing.characters?.length) throw new EngineError("INVALID_SPEECH_TIMING", "Subtitles require word or character alignment");
  const words: { word: string; start: number; end: number }[] = [];
  let word = "",
    start = 0,
    end = 0;
  let previousStart = -Infinity;
  const flush = () => {
    if (word) words.push({ word, start, end });
    word = "";
  };
  for (const c of timing.characters) {
    if (c.start < previousStart || c.end < c.start)
      throw new EngineError("INVALID_SPEECH_TIMING", "Character alignment must be ordered with nonnegative spans");
    previousStart = c.start;
    if (/\s/u.test(c.char)) {
      flush();
      continue;
    }
    if (!word) start = c.start;
    word += c.char;
    end = c.end;
  }
  flush();
  return words;
}
const rtl = (s: string) => /[\u0590-\u08ff]/u.test(s);
const clock = (seconds: number, ass = false) => {
  const unit = ass ? 100 : 1000;
  let t = Math.round(seconds * unit);
  const fraction = t % unit;
  t = Math.floor(t / unit);
  const second = t % 60;
  t = Math.floor(t / 60);
  return `${ass ? Math.floor(t / 60) : String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:${String(second).padStart(2, "0")}${ass ? "." : ","}${String(fraction).padStart(ass ? 2 : 3, "0")}`;
};
/** Pure: returned strings can be written by a tool or used directly by a library caller. */
export function subtitlesFromTiming(blocksInput: TimingBlock[], options: SubtitlesTimingOptions) {
  const blocks = z.array(TimingBlockSchema).min(1).parse(blocksInput),
    o = SubtitlesTimingOptionsSchema.parse(options);
  const limit = o.maxCharacters ?? 42,
    linesMax = o.maxLines ?? 2,
    min = o.minDuration ?? 1,
    max = o.maxDuration ?? 6;
  if (min > max) throw new EngineError("INVALID_ARGUMENT", "minDuration exceeds maxDuration");
  const cues: SubtitleCue[] = [];
  const limits = new WeakMap<SubtitleCue, number>();
  for (const b of blocks) {
    const from = b.sourceIn ?? 0,
      to = b.sourceOut ?? b.timing.duration ?? Infinity,
      offset = b.startFrame / o.fps + (b.startOffsetMs ?? 0) / 1000;
    if (to <= from || (b.startOffsetMs ?? 0) > 1000 / o.fps)
      throw new EngineError("INVALID_AUDIO_RANGE", "Invalid speech block trim or offset");
    if (b.timing.duration !== undefined && to > b.timing.duration)
      throw new EngineError("INVALID_AUDIO_RANGE", "Speech trim exceeds timing duration");
    const all = timingWords(b.timing);
    let prev = -Infinity;
    for (const w of all) {
      if (w.start < prev || w.end < w.start || !Number.isFinite(w.end))
        throw new EngineError("INVALID_SPEECH_TIMING", "Alignment must be ordered with nonnegative spans");
      prev = w.start;
    }
    const words = all
      .filter((w) => w.end > from && w.start < to)
      .map((w) => ({ ...w, start: offset + Math.max(0, w.start - from), end: offset + Math.min(to, w.end) - from }));
    let current: SubtitleCue | undefined;
    const flush = () => {
      if (current) {
        cues.push(current);
        limits.set(current, offset + to - from);
      }
      current = undefined;
    };
    for (const w of words) {
      if ([...w.word].length > limit || w.end - w.start > max)
        throw new EngineError("SUBTITLE_WORD_TOO_LONG", "A word cannot fit the requested cue limits without splitting");
      if (current && (w.start - current.end > (o.pauseThreshold ?? 0.6) || w.end - current.start > max)) flush();
      if (!current) current = { start: w.start, end: w.end, lines: [w.word] };
      else {
        const last = current.lines.length - 1;
        if ([...current.lines[last], ...w.word].length + 1 <= limit) current.lines[last] += " " + w.word;
        else if (current.lines.length < linesMax) current.lines.push(w.word);
        else {
          flush();
          current = { start: w.start, end: w.end, lines: [w.word] };
        }
        current.end = w.end;
      }
      if (/[.!?؟。！？]$/u.test(w.word)) flush();
    }
    flush();
  }
  cues.sort((a, b) => a.start - b.start);
  const warnings: string[] = [];
  cues.forEach((c, i) => {
    if (c.end > (cues[i + 1]?.start ?? Infinity))
      throw new EngineError("OVERLAPPING_SUBTITLES", "Speech blocks produce overlapping subtitle cues");
    c.end = Math.min(Math.max(c.end, c.start + min), cues[i + 1]?.start ?? Infinity, c.start + max, limits.get(c) ?? Infinity);
    if (c.end - c.start < min) warnings.push(`Cue ${i + 1} is shorter than minDuration to preserve the next cue's timing`);
  });
  const style = o.style ?? {},
    text = cues.flatMap((c) => c.lines).join(" ");
  const font = style.font ?? (rtl(text) ? "Noto Sans Arabic" : /[\uac00-\ud7af]/u.test(text) ? "Noto Sans CJK KR" : "Noto Sans");
  const directed = (line: string) =>
    style.direction === "rtl" || (style.direction !== "ltr" && rtl(line)) ? "\u202b" + line + "\u202c" : line;
  const assText = (line: string) =>
    directed(line)
      .replace(/\\/g, "＼")
      .replace(/[{}]/g, "")
      .replace(/[\r\n]/g, " ");
  const ass =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${o.width ?? 1920}\nPlayResY: ${o.height ?? 1080}\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,${font},${style.size ?? 48},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${style.outline ?? 2},0,${style.position ?? 2},${style.margin ?? 60},${style.margin ?? 60},${style.margin ?? 60},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    cues
      .map((c) => `Dialogue: 0,${clock(c.start, true)},${clock(c.end, true)},Default,,0,0,0,,${c.lines.map(assText).join("\\N")}\n`)
      .join("");
  const srt = cues.map((c, i) => `${i + 1}\n${clock(c.start)} --> ${clock(c.end)}\n${c.lines.map(directed).join("\n")}\n`).join("\n");
  return { cues, ass, srt, warnings };
}
