/**
 * Colour utilities: sRGB (8-bit) -> CIE L*a*b* (D65) and CIE76 Delta-E (Euclidean distance in Lab).
 * ΔE ≈ 1 is a just-noticeable difference; ΔE > 20 is an obviously different colour.
 */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

const Xn = 0.95047;
const Yn = 1.0;
const Zn = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = SRGB_TO_LINEAR[r | 0];
  const G = SRGB_TO_LINEAR[g | 0];
  const B = SRGB_TO_LINEAR[b | 0];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / Xn;
  const Y = (0.2126729 * R + 0.7151522 * G + 0.072175 * B) / Yn;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / Zn;
  const fx = f(X);
  const fy = f(Y);
  const fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE(p: Lab, q: Lab): number {
  const dL = p.L - q.L;
  const da = p.a - q.a;
  const db = p.b - q.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * ΔE of every pixel of an RGBA buffer against a reference colour. Uses a per-colour cache since
 * generated images typically contain far fewer unique colours than pixels.
 */
export function deltaEMap(data: Uint8ClampedArray, ref: RGB): Float32Array {
  const n = data.length >> 2;
  const out = new Float32Array(n);
  const refLab = rgbToLab(ref.r, ref.g, ref.b);
  const cache = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let d = cache.get(key);
    if (d === undefined) {
      d = deltaE(rgbToLab(r, g, b), refLab);
      if (cache.size < 1 << 20) cache.set(key, d);
    }
    out[i] = d;
  }
  return out;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function toHex({ r, g, b }: RGB): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
