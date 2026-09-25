/**
 * Runs the Blender 3D backend headless (`blender -b --factory-startup -noaudio --python
 * engine3d.py -- job.json`) and reads its VE3D event lines. Blender is found via BLENDER_PATH or
 * PATH. Clients never see Blender: failures become EngineErrors with stable codes.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EngineError, type EngineErrorCode } from "../errors.js";

export interface BlenderInfo {
  available: boolean;
  path: string;
  version: string | null;
  script: string | null;
  error?: string;
}

let cached: BlenderInfo | null = null;

export function blenderPath(): string {
  return process.env.BLENDER_PATH || "blender";
}

/** engine3d.py next to this module (src/scene3d/blender/ in dev, blender/ next to a bundle). */
export function engineScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.VIDEO_ENGINE_BLENDER_SCRIPT,
    path.join(here, "blender", "engine3d.py"),
    path.join(here, "engine3d.py"),
    path.join(here, "..", "src", "scene3d", "blender", "engine3d.py"),
    path.join(here, "..", "..", "src", "scene3d", "blender", "engine3d.py"),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Detects Blender once per process (version check, ~1 s). */
export function blenderInfo(refresh = false): BlenderInfo {
  if (cached && !refresh) return cached;
  const p = blenderPath();
  const script = engineScript();
  const r = spawnSync(p, ["-b", "--factory-startup", "-noaudio", "--version"], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) {
    cached = { available: false, path: p, version: null, script, error: r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || "").slice(-300)}` };
  } else {
    const m = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(r.stdout);
    const version = m ? m[1] : null;
    const major = version ? Number(version.split(".")[0]) : 0;
    cached =
      major >= 3
        ? { available: !!script, path: p, version, script, ...(script ? {} : { error: "engine3d.py not found" }) }
        : { available: false, path: p, version, script, error: `Blender ${version ?? "?"} found; 3.6 or newer is required` };
  }
  return cached;
}

export function requireBlender(): BlenderInfo {
  const info = blenderInfo();
  if (!info.available) {
    throw new EngineError("ENGINE_CAPABILITY_UNAVAILABLE", `3D rendering needs Blender (3.6+ headless) on PATH or in BLENDER_PATH: ${info.error}`, {
      blender: info,
      install: "apt install blender python3-numpy  (see docs/3D.md)",
    });
  }
  return info;
}

export interface BlenderEvent {
  event: string;
  [k: string]: any;
}

export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (e: BlenderEvent) => void;
  /** Kill if no event arrives for this long (default 10 min; a single high-quality frame can be slow). */
  idleTimeoutMs?: number;
}

/** Runs one job; resolves with all events, or throws an EngineError (code from the backend). */
export async function runBlenderJob(job: Record<string, unknown>, o: RunOptions = {}): Promise<BlenderEvent[]> {
  const info = requireBlender();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ve3d-"));
  const jobFile = path.join(dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const args = ["-b", "--factory-startup", "-noaudio", "--python-exit-code", "4", "--python", info.script!, "--", jobFile];
  const proc = spawn(info.path, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const events: BlenderEvent[] = [];
  let buf = "";
  let stderr = "";
  let tail = "";
  let idle: NodeJS.Timeout | undefined;
  let killedFor: "cancel" | "timeout" | null = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      killedFor = "timeout";
      proc.kill("SIGKILL");
    }, o.idleTimeoutMs ?? 600_000);
  };
  const onAbort = () => {
    killedFor = "cancel";
    proc.kill("SIGKILL");
  };
  o.signal?.addEventListener("abort", onAbort, { once: true });
  if (o.signal?.aborted) onAbort();
  arm();
  proc.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("VE3D ")) {
        try {
          const ev = JSON.parse(line.slice(5)) as BlenderEvent;
          events.push(ev);
          arm();
          o.onEvent?.(ev);
        } catch {
          /* ignore malformed */
        }
      } else {
        tail = (tail + line + "\n").slice(-4000);
      }
    }
  });
  proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const code: number | null = await new Promise((resolve) => {
    proc.on("error", () => resolve(-1));
    proc.on("close", (c) => resolve(c));
  });
  clearTimeout(idle);
  o.signal?.removeEventListener("abort", onAbort);
  fs.rmSync(dir, { recursive: true, force: true });
  if (killedFor === "cancel") throw new EngineError("RENDER_CANCELLED", "Render cancelled");
  if (killedFor === "timeout") throw new EngineError("RENDER_FAILED", "3D backend stopped responding (timeout)", { log: tail.slice(-1500) });
  const err = events.find((e) => e.event === "error");
  if (err) throw new EngineError((err.code as EngineErrorCode) ?? "RENDER_FAILED", `3D backend: ${err.message}`, err.details ?? {});
  if (code !== 0 || !events.some((e) => e.event === "done")) {
    throw new EngineError("RENDER_FAILED", `3D backend failed (exit ${code})`, { log: (tail + stderr).slice(-1500) });
  }
  return events;
}

const probes = new Map<string, Promise<boolean>>();

/** Whether `engine` renders headless on this machine (EEVEE needs EGL/OpenGL). Cached per process. */
export function engineWorks(engine: "eevee" | "cycles" | "workbench"): Promise<boolean> {
  let p = probes.get(engine);
  if (!p) {
    p = (async () => {
      if (!blenderInfo().available) return false;
      const out = path.join(os.tmpdir(), `ve3d-probe-${process.pid}-${engine}.png`);
      try {
        const ev = await runBlenderJob(
          { mode: "probe", out, width: 64, height: 64, fps: 24, render: { quality: "draft", engine, transparent: false } },
          { idleTimeoutMs: 60_000 },
        );
        return ev.some((e) => e.event === "probe" && e.ok);
      } catch {
        return false;
      } finally {
        fs.rmSync(out, { force: true });
      }
    })();
    probes.set(engine, p);
  }
  return p;
}

/**
 * Renderer unless the scene forces one: EEVEE (fast raster, needs EGL/OpenGL) when it works on
 * this machine, otherwise Cycles (CPU path tracer, always works headless, much slower).
 */
export async function chooseEngine(quality: string, forced?: string): Promise<"eevee" | "cycles" | "workbench"> {
  if (forced === "eevee" || forced === "cycles" || forced === "workbench") return forced;
  void quality;
  if (process.env.VIDEO_ENGINE_3D_ENGINE !== "cycles" && (await engineWorks("eevee"))) return "eevee";
  return "cycles";
}
