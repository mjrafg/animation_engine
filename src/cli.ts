#!/usr/bin/env node
/**
 * CLI.
 *
 *   ae validate  <scene.json>
 *   ae preview   <scene.json> <frame> <out.png> [--debug]
 *   ae layout    <scene.json> <frame> [layerId ...]
 *   ae video     <scene.json> <out.mp4> [--start N] [--end N] [--crf N] [--no-audio]
 *   ae process   <input.png> <outDir> [options.json]
 * Output paths given on the command line are relative to the current directory; paths inside
 * `ae tool` / `ae batch` JSON args are relative to the scene directory.
 *
 *   ae tool      <toolName> '<json args>' [--scene scene.json]   (any agent tool, JSON in/out)
 *   ae tools                                                    (list tool definitions)
 *   ae batch     <commands.json>     ([{ "tool": "...", "args": {...} }, ...] run in one session)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { EngineSession, toolDefinitions } from "./api/tools.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const s = new EngineSession();
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const load = async (file: string) => {
    const r = await s.call("load_scene", { path: file });
    if (!r.ok) {
      print(r);
      process.exit(1);
    }
    return r;
  };
  const done = (r: { ok: boolean }) => {
    print(r);
    process.exit(r.ok ? 0 : 1);
  };

  switch (cmd) {
    case "validate": {
      await load(rest[0]);
      return done(await s.call("validate_scene"));
    }
    case "preview": {
      await load(rest[0]);
      const tool = rest.includes("--debug") ? "render_debug_preview" : "render_preview";
      return done(await s.call(tool, { frame: Number(rest[1]), out: path.resolve(rest[2]) }));
    }
    case "layout": {
      await load(rest[0]);
      const layers = rest.slice(2);
      return done(await s.call("measure_layout", { frame: Number(rest[1]), ...(layers.length ? { layers } : {}) }));
    }
    case "video": {
      await load(rest[0]);
      const args: Record<string, unknown> = { out: path.resolve(rest[1]) };
      if (flag(rest, "--start")) args.startFrame = Number(flag(rest, "--start"));
      if (flag(rest, "--end")) args.endFrame = Number(flag(rest, "--end"));
      if (flag(rest, "--crf")) args.crf = Number(flag(rest, "--crf"));
      if (rest.includes("--no-audio")) args.audio = false;
      return done(await s.call("render_video", args));
    }
    case "process": {
      const options = rest[2] ? JSON.parse(await fs.readFile(rest[2], "utf8")) : {};
      return done(await s.call("process_asset_background", { input: rest[0], outDir: rest[1], options }));
    }
    case "tool": {
      const scene = flag(rest, "--scene");
      if (scene) await load(scene);
      return done(await s.call(rest[0], rest[1] ? JSON.parse(rest[1]) : {}));
    }
    case "tools":
      return print(toolDefinitions());
    case "batch": {
      const commands = JSON.parse(await fs.readFile(rest[0], "utf8")) as { tool: string; args?: unknown }[];
      const results = [];
      for (const c of commands) {
        const r = await s.call(c.tool, c.args ?? {});
        results.push({ tool: c.tool, ...r });
        if (!r.ok) break;
      }
      print(results);
      process.exit(results.every((r) => r.ok) ? 0 : 1);
    }
    default:
      console.error("usage: see header of src/cli.ts (validate | preview | layout | video | process | tool | tools | batch)");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
