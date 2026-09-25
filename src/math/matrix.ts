/**
 * 2D affine matrix in the same layout as the Canvas 2D API / CSS `matrix(a, b, c, d, e, f)`:
 *
 *   | a  c  e |     x' = a·x + c·y + e
 *   | b  d  f |     y' = b·x + d·y + f
 *   | 0  0  1 |
 *
 * Coordinates are pixels with +x to the right and +y downward, so a positive rotation
 * angle turns clockwise on screen.
 */
export interface Mat2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const IDENTITY: Readonly<Mat2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function identity(): Mat2D {
  return { ...IDENTITY };
}

/** Returns m1 · m2 (m2 is applied first, then m1). */
export function multiply(m1: Mat2D, m2: Mat2D): Mat2D {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** Multiplies left to right: compose(A, B, C) = A · B · C (C is applied first). */
export function compose(...ms: Mat2D[]): Mat2D {
  return ms.reduce((acc, m) => multiply(acc, m), identity());
}

export function translate(x: number, y: number): Mat2D {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scale(sx: number, sy: number = sx): Mat2D {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export const DEG2RAD = Math.PI / 180;

/** Clockwise rotation (on a y-down canvas) by `degrees`. */
export function rotateDeg(degrees: number): Mat2D {
  const r = degrees * DEG2RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function invert(m: Mat2D): Mat2D | null {
  const det = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    e: (m.c * m.f - m.d * m.e) * inv,
    f: (m.b * m.e - m.a * m.f) * inv,
  };
}

export function apply(m: Mat2D, p: Vec2): Vec2 {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function boundsOfPoints(points: Vec2[]): Rect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  return { left, top, right, bottom };
}

/** Rounds away floating-point noise (e.g. 1e-13) so reported geometry is stable and readable. */
export function clean(n: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

export function cleanVec(p: Vec2): Vec2 {
  return { x: clean(p.x), y: clean(p.y) };
}

export function cleanRect(r: Rect): Rect {
  return { left: clean(r.left), top: clean(r.top), right: clean(r.right), bottom: clean(r.bottom) };
}

export function cleanMat(m: Mat2D): Mat2D {
  return { a: clean(m.a), b: clean(m.b), c: clean(m.c), d: clean(m.d), e: clean(m.e), f: clean(m.f) };
}
