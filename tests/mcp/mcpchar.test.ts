/**
 * Character runtime over MCP (built server, real stdio): an agent-style session that uses only
 * high-level character tools (no keyframes) and gets structured errors.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpDir } from "../helpers.js";
import { McpStdioClient, SERVER } from "./client.js";

const ROOT = path.resolve(__dirname, "..", "..");
const HELLO = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "speech", "hello_pip.json"), "utf8"));
const WS = "wc";
let c: McpStdioClient;

beforeAll(async () => {
  if (!fs.existsSync(SERVER)) throw new Error("Build the server first: npm run build:mcp");
  c = new McpStdioClient({ VIDEO_ENGINE_ROOT: tmpDir("mcpchar-"), VIDEO_ENGINE_LIBRARIES: `characters=${path.join(ROOT, "assets", "characters")}` });
  await c.initialize();
  await c.call("workspace_create", { workspaceId: WS });
}, 30_000);

afterAll(async () => {
  await c?.close();
});

const ok = async (tool: string, args: Record<string, unknown>) => {
  const r = await c.call(tool, { workspaceId: WS, ...args });
  expect(r.ok, `${tool}: ${r.text.slice(0, 900)}`).toBe(true);
  return r.data;
};
const err = async (tool: string, args: Record<string, unknown>) => {
  const r = await c.call(tool, { workspaceId: WS, ...args });
  expect(r.ok, `${tool} should fail`).toBe(false);
  return r.data.error as { code: string; message: string; details: any };
};

describe("characters over MCP", () => {
  it("discovers, prepares and inspects characters", async () => {
    const caps = (await c.call("engine_capabilities")).data;
    expect(caps.characters.tools).toContain("character_actions");
    const list = await ok("character_list", { library: "characters" });
    expect(list.packages.map((p: any) => p.characterId)).toEqual(expect.arrayContaining(["mika", "pip"]));
    const imp = await ok("character_import", { source: { library: "characters", path: "pip" } });
    expect(imp.reused).toBe(false);
    expect((await ok("character_import", { source: { library: "characters", path: "pip" } })).reused).toBe(true);
    const cap = await ok("character_inspect", { characterId: "pip" });
    expect(cap.actions.map((a: any) => a.name)).toEqual(expect.arrayContaining(["walk", "talk", "smile", "blink", "wave"]));
    expect(cap.sockets.rightHand).toBe("hand_r:grip");
    expect((await err("character_inspect", { characterId: "ghost" })).code).toBe("CHARACTER_NOT_FOUND");
  });

  it("places a character and animates it with high-level actions only", async () => {
    await ok("scene_create", { sceneId: "s", canvas: { width: 480, height: 270, fps: 12, background: "#cfe8f7" }, duration: 96 });
    await ok("character_add", { sceneId: "s", character: { id: "pip1", character: "pip", x: 80, y: 250, scale: 0.6 } });
    await ok("speech_timing_save", { timingId: "hello", timing: HELLO });
    const r = await ok("character_actions", {
      sceneId: "s",
      character: "pip1",
      operations: [
        { type: "add", action: { action: "walk", start: 0.5, duration: 3, direction: "right" } },
        { type: "add", action: { action: "talk", start: 3.8, speech: "hello" } },
        { type: "add", action: { action: "smile", start: 4, duration: 3 } },
        { type: "add", action: { action: "blink", start: 5 } },
      ],
    });
    const byName = Object.fromEntries(r.timeline.actions.map((a: any) => [a.action, a]));
    expect(byName.walk.resolved.to.x).toBeCloseTo(80 + 3 * 200 * 0.6, 3);
    expect(byName.talk.resolved.speechSource).toBe("characters");
    expect(byName.smile.resolved.channel).toBe("expression");
    expect(r.timeline.generated.tracks).toBeGreaterThan(5);
    const errors: [Record<string, unknown>, string][] = [
      [{ sceneId: "s", character: "pip1", operations: [{ type: "add", action: { action: "run", start: 1, duration: 1, direction: "left" } }] }, "ACTION_CONFLICT"],
      [{ sceneId: "s", character: "pip1", operations: [{ type: "add", action: { action: "fly", start: 1, duration: 1 } }] }, "ACTION_NOT_SUPPORTED"],
      [{ sceneId: "s", character: "nobody", operations: [{ type: "clear" }] }, "CHARACTER_NOT_FOUND"],
      [{ sceneId: "s", character: "pip1", operations: [{ type: "update", id: "a42", patch: { start: 1 } }] }, "ACTION_NOT_FOUND"],
    ];
    for (const [args, code] of errors) expect((await err("character_actions", args)).code).toBe(code);
    expect((await err("timeline_apply", { sceneId: "s", operations: [{ type: "keyframe.add", target: "pip1", property: "x", frame: 3, value: 1 }] })).code).toBe("OWNED_BY_CHARACTER");
    // edit: move the talk later and extend the smile
    const tl = (await ok("character_timeline", { sceneId: "s" })).characters[0];
    const talkId = tl.actions.find((a: any) => a.action === "talk").id;
    const smileId = tl.actions.find((a: any) => a.action === "smile").id;
    const e = await ok("character_actions", { sceneId: "s", character: "pip1", operations: [{ type: "update", id: talkId, patch: { start: 4.2 } }, { type: "update", id: smileId, patch: { duration: 3.5 } }] });
    expect(e.timeline.actions.find((a: any) => a.id === talkId).start).toBe(4.2);
    const pv = await ok("render_preview", { sceneId: "s", frame: 60 });
    expect(fs.existsSync(pv.viewPath)).toBe(true);
    const job = await ok("render_video_start", { sceneId: "s" });
    const st = await ok("render_video_status", { renderId: job.renderId, waitSeconds: 45 });
    expect(st.status).toBe("completed");
    const scene = (await ok("scene_get", { sceneId: "s" })).scene;
    expect(scene.characters[0].actions).toHaveLength(4);
  }, 120_000);
});
