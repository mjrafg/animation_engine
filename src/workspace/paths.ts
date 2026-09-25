/**
 * Path safety for workspaces. Agent-facing APIs never take host paths; the few inputs that name a
 * file (an inbox file, a library file) are RELATIVE paths that must resolve inside a known root,
 * including after following symlinks.
 */
import fs from "node:fs";
import path from "node:path";
import { EngineError } from "../errors.js";

export const WORKSPACE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const ENTITY_ID_RE = /^[A-Za-z_][A-Za-z0-9_\-.]{0,79}$/;

export function checkWorkspaceId(id: unknown): string {
  if (typeof id !== "string" || !WORKSPACE_ID_RE.test(id)) {
    throw new EngineError("INVALID_ID", `Invalid workspace id ${JSON.stringify(id)}: use 1-64 chars of a-z, 0-9, _ or -, starting with a letter or digit`, { workspaceId: id });
  }
  return id;
}

export function checkEntityId(kind: string, id: unknown): string {
  if (typeof id !== "string" || !ENTITY_ID_RE.test(id)) {
    throw new EngineError("INVALID_ID", `Invalid ${kind} id ${JSON.stringify(id)}: start with a letter or _, then letters, digits, _ - . (max 80)`, { [`${kind}Id`]: id });
  }
  return id;
}

/**
 * Resolves `rel` inside `root`. Rejects absolute paths, `..` escapes, NUL bytes and symlinks that
 * point outside the root. The returned path may not exist yet (its nearest existing ancestor is
 * checked).
 */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) {
    throw new EngineError("PATH_OUTSIDE_WORKSPACE", "A non-empty relative path is required", { path: rel });
  }
  if (path.isAbsolute(rel) || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\")) {
    throw new EngineError("PATH_OUTSIDE_WORKSPACE", `Absolute paths are not allowed: ${rel}`, { path: rel });
  }
  const rootReal = fs.realpathSync(root);
  const target = path.resolve(rootReal, rel.replace(/\\/g, "/"));
  if (target !== rootReal && !target.startsWith(rootReal + path.sep)) {
    throw new EngineError("PATH_OUTSIDE_WORKSPACE", `Path escapes its root: ${rel}`, { path: rel });
  }
  // follow symlinks on the existing part of the path
  let probe = target;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new EngineError("PATH_OUTSIDE_WORKSPACE", `Path resolves outside its root through a symlink: ${rel}`, { path: rel });
  }
  return target;
}

/** Write via a temp file + rename so readers never see a half-written file. */
export function writeFileAtomic(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export const toPosix = (p: string) => p.split(path.sep).join("/");
