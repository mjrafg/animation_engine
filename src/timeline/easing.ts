/**
 * Easing curves. Each maps normalised segment progress t ∈ [0,1] to eased progress.
 * `step` is handled by the evaluator (it holds the left keyframe's value until the next key).
 */
import type { Interpolation } from "../scene/schema.js";

export type EasingFn = (t: number) => number;

/**
 * CSS-compatible cubic-bezier(x1, y1, x2, y2) easing. Solves x(s) = t for s with Newton's method
 * and falls back to bisection, then returns y(s). Fully deterministic.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const sampleDX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  const solveX = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-7) return s;
      const d = sampleDX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 60; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-7) return s;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solveX(t));
  };
}

// Same control points as CSS `ease-in`, `ease-out`, `ease-in-out`.
const EASE_IN = cubicBezier(0.42, 0, 1, 1);
const EASE_OUT = cubicBezier(0, 0, 0.58, 1);
const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);

export function easingFor(interp: Interpolation, bezier?: readonly [number, number, number, number]): EasingFn {
  switch (interp) {
    case "step":
      return () => 0;
    case "linear":
      return (t) => t;
    case "ease-in":
      return EASE_IN;
    case "ease-out":
      return EASE_OUT;
    case "ease-in-out":
      return EASE_IN_OUT;
    case "cubic-bezier":
      return bezier ? cubicBezier(bezier[0], bezier[1], bezier[2], bezier[3]) : (t) => t;
  }
}
