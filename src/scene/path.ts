/** Strict SVG path grammar gate. Skia parses validated path data; no code evaluation. */
export function validPathData(d: string): boolean {
  if (!d || d.length > 65536 || /,\s*(?:,|[AaCcHhLlMmQqSsTtVvZz]|$)|[AaCcHhLlMmQqSsTtVvZz]\s*,/.test(d)) return false;
  const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  if (d.replace(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?|[\s,]/g, "") || !/^[Mm]$/.test(tokens[0] ?? ""))
    return false;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  let i = 0;
  while (i < tokens.length) {
    const command = tokens[i++].toUpperCase(),
      n = arity[command];
    if (n === undefined) return false;
    if (!n) continue;
    let groups = 0;
    while (i < tokens.length && !/^[a-z]$/i.test(tokens[i])) {
      if (i + n > tokens.length) return false;
      const values = tokens.slice(i, i + n).map(Number);
      if (values.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e7)) return false;
      if (command === "A" && (values[0] < 0 || values[1] < 0 || ![0, 1].includes(values[3]) || ![0, 1].includes(values[4]))) return false;
      i += n;
      groups++;
    }
    if (!groups) return false;
  }
  return true;
}
