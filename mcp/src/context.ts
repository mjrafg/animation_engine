/**
 * Server configuration and per-process context. Configuration comes from CLI flags or environment
 * (Tandem passes non-secret env per integration):
 *
 *   VIDEO_ENGINE_ROOT        directory holding all workspaces              (--root)
 *   VIDEO_ENGINE_WORKSPACE   optional: lock this server to ONE workspace   (--workspace)
 *   VIDEO_ENGINE_LIBRARIES   optional read-only asset libraries "name=/dir;name2=/dir2"  (--library name=/dir)
 *   VIDEO_ENGINE_LOG         optional JSONL log file (default <root>/.logs/mcp.jsonl); never stderr
 *   VIDEO_ENGINE_MAX_RENDERS concurrent video renders per workspace (default 1)
 *   FFMPEG_PATH              optional FFmpeg binary (default: bundled ffmpeg-static)
 */
import fs from "node:fs";
import path from "node:path";
import { RenderJobs } from "../../src/workspace/jobs.js";
import { WorkspaceManager, type VideoWorkspace } from "../../src/workspace/workspace.js";

export interface ServerConfig {
  root: string;
  lockedWorkspace?: string;
  libraries: Record<string, string>;
  logFile: string;
  maxRenders: number;
}

export function parseLibraries(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (spec ?? "").split(/[;\n]/)) {
    const m = part.trim().match(/^([A-Za-z0-9_-]+)=(.+)$/);
    if (m) out[m[1]] = path.resolve(m[2].trim());
  }
  return out;
}

export function configFrom(argv: string[], env: NodeJS.ProcessEnv): ServerConfig {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const libs = parseLibraries(env.VIDEO_ENGINE_LIBRARIES);
  argv.forEach((a, i) => {
    if (a === "--library" && argv[i + 1]) Object.assign(libs, parseLibraries(argv[i + 1]));
  });
  const root = path.resolve(flag("--root") ?? env.VIDEO_ENGINE_ROOT ?? path.join(env.HOME ?? process.cwd(), ".video-engine", "workspaces"));
  return {
    root,
    lockedWorkspace: flag("--workspace") ?? env.VIDEO_ENGINE_WORKSPACE ?? undefined,
    libraries: libs,
    logFile: path.resolve(flag("--log") ?? env.VIDEO_ENGINE_LOG ?? path.join(root, ".logs", "mcp.jsonl")),
    maxRenders: Math.max(1, Number(env.VIDEO_ENGINE_MAX_RENDERS ?? 1) || 1),
  };
}

export class ServerContext {
  readonly manager: WorkspaceManager;
  private jobs = new Map<string, RenderJobs>();

  constructor(readonly config: ServerConfig) {
    this.manager = new WorkspaceManager({ root: config.root, lockedWorkspace: config.lockedWorkspace, libraries: config.libraries });
  }

  workspace(id: string): VideoWorkspace {
    return this.manager.open(id);
  }

  jobsFor(ws: VideoWorkspace): RenderJobs {
    let j = this.jobs.get(ws.id);
    if (!j) this.jobs.set(ws.id, (j = new RenderJobs(ws, this.config.maxRenders)));
    return j;
  }

  shutdown() {
    for (const j of this.jobs.values()) j.interruptAll();
  }

  /** Structured operation log (JSONL). Never written to stdout/stderr: stdout is the MCP channel. */
  log(entry: Record<string, unknown>) {
    try {
      fs.mkdirSync(path.dirname(this.config.logFile), { recursive: true });
      fs.appendFileSync(this.config.logFile, JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n");
    } catch {
      /* logging must never break a tool call */
    }
  }
}
