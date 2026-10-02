/**
 * Render jobs: long video renders run in the background with persisted progress, so callers with
 * short request timeouts (MCP clients) can start a render, poll it (optionally long-polling), and
 * cancel it. Job state lives in <workspace>/jobs/<renderId>.json; a job that was running when its
 * process died is reported as "interrupted" instead of hanging forever.
 */
import type { PrepareVideoOptions } from "../media/prepare.js";
import type { RenderVideoOptions } from "../api/engine.js";
import fs from "node:fs";
import path from "node:path";
import { requireBlender } from "../scene3d/blender.js";
import { EngineError } from "../errors.js";
import { checkEntityId, readJson, writeFileAtomic } from "./paths.js";
import type { ArtifactRecord, VideoWorkspace } from "./workspace.js";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface RenderJob {
  renderId: string;
  workspaceId: string;
  sceneId: string;
  status: JobStatus;
  /** Frames rendered so far / frames to render. */
  frame: number;
  totalFrames: number;
  progress: number;
  options: Omit<RenderVideoOptions, "signal" | "onProgress">;
  preparation?: { input: string; options: PrepareVideoOptions; assetId?: string };
  result?: unknown;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  elapsedSeconds?: number;
  artifact?: ArtifactRecord;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  pid: number;
}

const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled", "interrupted"];

export class RenderJobs {
  private active = new Map<string, { job: RenderJob; ctrl: AbortController; done: Promise<void>; resolve: () => void }>();
  private queue: string[] = [];
  private running = 0;

  constructor(
    private ws: VideoWorkspace,
    private maxConcurrent = 1,
  ) {
    this.recover();
  }

  private file(id: string) {
    return path.join(this.ws.dir, "jobs", `${id}.json`);
  }

  private save(job: RenderJob) {
    writeFileAtomic(this.file(job.renderId), JSON.stringify(job, null, 2));
  }

  /** Jobs left running/queued by a process that no longer owns them are marked interrupted. */
  private recover() {
    const dir = path.join(this.ws.dir, "jobs");
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const job = readJson<RenderJob>(path.join(dir, f));
      if (!TERMINAL.includes(job.status) && !this.active.has(job.renderId)) {
        job.status = "interrupted";
        job.finishedAt = new Date().toISOString();
        job.error = { code: "RENDER_INTERRUPTED", message: "The render process stopped before the job finished; start a new render" };
        this.save(job);
      }
    }
  }

  async start(sceneId: string, options: RenderJob["options"] = {}): Promise<RenderJob> {
    const duration = await this.ws.sceneDuration(sceneId); // validates the scene (2D or 3D) up front
    const start = options.startFrame ?? 0;
    const end = options.endFrame ?? duration;
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= duration)) {
      throw new EngineError("INVALID_FRAME", `Invalid frame range [${start}, ${end}) for a ${duration}-frame scene`, {
        startFrame: start,
        endFrame: end,
        duration,
      });
    }
    if (this.ws.sceneKind(sceneId) === "3d") requireBlender();
    const renderId = this.ws.nextId("render");
    const job: RenderJob = {
      renderId,
      workspaceId: this.ws.id,
      sceneId,
      status: "queued",
      frame: 0,
      totalFrames: end - start,
      progress: 0,
      options,
      createdAt: new Date().toISOString(),
      pid: process.pid,
    };
    this.save(job);
    const ctrl = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.active.set(renderId, { job, ctrl, done, resolve: resolveDone });
    this.queue.push(renderId);
    const snapshot = { ...job };
    this.pump();
    return snapshot;
  }

  async startPreparation(input: string, options: PrepareVideoOptions = {}, assetId?: string): Promise<RenderJob> {
    const renderId = this.ws.nextId("render");
    const job: RenderJob = {
      renderId,
      workspaceId: this.ws.id,
      sceneId: "",
      status: "queued",
      frame: 0,
      totalFrames: 1,
      progress: 0,
      options: {},
      preparation: { input, options, assetId },
      createdAt: new Date().toISOString(),
      pid: process.pid,
    };
    this.save(job);
    const ctrl = new AbortController();
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    this.active.set(renderId, { job, ctrl, done, resolve });
    this.queue.push(renderId);
    const snapshot = { ...job };
    this.pump();
    return snapshot;
  }

  private pump() {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const entry = this.active.get(id);
      if (!entry) continue;
      this.running++;
      this.run(entry.job, entry.ctrl).finally(() => {
        this.running--;
        this.active.delete(id);
        entry.resolve();
        this.pump();
      });
    }
  }

  private async run(job: RenderJob, ctrl: AbortController) {
    if (ctrl.signal.aborted) {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      this.save(job);
      return;
    }
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.save(job);
    const t0 = Date.now();
    let lastSave = 0;
    try {
      if (job.preparation) {
        const p = job.preparation;
        job.result = await this.ws.prepareVideo(p.input, p.options, p.assetId, ctrl.signal);
      } else {
        const artifact = await this.ws.renderVideo(job.sceneId, {
          ...job.options,
          signal: ctrl.signal,
          renderId: job.renderId,
          onProgress: (done, total) => {
            job.frame = done;
            job.progress = +(done / total).toFixed(4);
            if (Date.now() - lastSave > 400 || done === total) {
              lastSave = Date.now();
              this.save(job);
            }
          },
        });
        job.artifact = artifact;
      }
      job.status = "completed";
      job.progress = 1;
      job.frame = job.totalFrames;
    } catch (e) {
      const err = e instanceof EngineError ? e : new EngineError("RENDER_FAILED", e instanceof Error ? e.message : String(e));
      job.status = err.code === "RENDER_CANCELLED" ? "cancelled" : "failed";
      job.error = { code: err.code, message: err.message, ...(Object.keys(err.details).length ? { details: err.details } : {}) };
    }
    job.finishedAt = new Date().toISOString();
    job.elapsedSeconds = +((Date.now() - t0) / 1000).toFixed(2);
    this.save(job);
  }

  get(renderId: string): RenderJob {
    checkEntityId("render", renderId);
    const live = this.active.get(renderId);
    if (live) return { ...live.job };
    if (!fs.existsSync(this.file(renderId))) throw new EngineError("RENDER_NOT_FOUND", `Render "${renderId}" does not exist`, { renderId });
    return readJson<RenderJob>(this.file(renderId));
  }

  /** Returns the job, waiting up to `waitMs` for it to reach a terminal state. */
  async wait(renderId: string, waitMs = 0): Promise<RenderJob> {
    const live = this.active.get(renderId);
    if (live && waitMs > 0) {
      await Promise.race([live.done, new Promise((r) => setTimeout(r, waitMs))]);
    }
    return this.get(renderId);
  }

  cancel(renderId: string): RenderJob {
    const live = this.active.get(renderId);
    if (!live) {
      const job = this.get(renderId);
      return job; // already finished: cancelling is a no-op
    }
    live.ctrl.abort();
    const qi = this.queue.indexOf(renderId);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      live.job.status = "cancelled";
      live.job.finishedAt = new Date().toISOString();
      this.save(live.job);
      this.active.delete(renderId);
      live.resolve();
    }
    return { ...live.job };
  }

  list(): RenderJob[] {
    const dir = path.join(this.ws.dir, "jobs");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.get(f.slice(0, -5)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Marks every unfinished job interrupted (called on shutdown). */
  interruptAll() {
    for (const { job, ctrl } of this.active.values()) {
      ctrl.abort();
      job.status = "interrupted";
      job.finishedAt = new Date().toISOString();
      job.error = { code: "RENDER_INTERRUPTED", message: "The render server shut down before the job finished" };
      this.save(job);
    }
  }
}
