/** Explicit opt-in network script. Normal builds/tests/demo renders never call ElevenLabs. */
import fs from "node:fs/promises";
import path from "node:path";
import { elevenLabsToSpeechTiming } from "./timing.js";
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("Set ELEVENLABS_API_KEY in the environment to regenerate fixtures");
const dir = path.resolve("examples/footage-proof/fixtures");
for (const lang of ["fa", "ko"]) {
  const meta = JSON.parse(await fs.readFile(path.join(dir, `${lang}.provenance.json`), "utf8"));
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(meta.voice)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text: meta.text, model_id: "eleven_v3", language_code: lang }),
    },
  );
  if (!response.ok) throw new Error(`ElevenLabs failed: HTTP ${response.status}`); // never log headers or response bodies
  const data = await response.json();
  const timing = elevenLabsToSpeechTiming(data);
  await fs.writeFile(path.join(dir, `${lang}.mp3`), Buffer.from(data.audio_base64, "base64"));
  await fs.writeFile(
    path.join(dir, `${lang}.alignment.json`),
    JSON.stringify({ alignment: data.alignment, normalized_alignment: data.normalized_alignment }, null, 2),
  );
  await fs.writeFile(path.join(dir, `${lang}.timing.json`), JSON.stringify(timing, null, 2));
  const { generationId: _previousGeneration, sentenceIntervals: _estimatedIntervals, ...provenance } = meta;
  await fs.writeFile(
    path.join(dir, `${lang}.provenance.json`),
    JSON.stringify({ ...provenance, timingSource: "ElevenLabs with-timestamps", duration: timing.duration }, null, 2),
  );
}
