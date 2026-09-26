/**
 * Multi-character interactions over MCP (built server, real stdio): discovery, compatibility,
 * custom definitions, apply/edit/remove and inspection, using only high-level tools.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpDir } from "../helpers.js";
import { McpStdioClient, SERVER } from "./client.js";

const ROOT = path.resolve(__dirname, "..", "..");
const WS = "wi";
let c: McpStdioClient;

beforeAll(async () => {
  if (!fs.existsSync(SERVER)) throw new Error("Build the server first: npm run build:mcp");
  c = new McpStdioClient({
    VIDEO_ENGINE_ROOT: tmpDir("mcpix-"),
    VIDEO_ENGINE_LIBRARIES: `characters=${path.join(ROOT, "assets", "characters")};interactions=${path.join(ROOT, "assets", "interactions")}`,
  });
  await c.initialize();
  await c.call("workspace_create", { workspaceId: WS });
  await c.call("character_import", { workspaceId: WS, source: { library: "characters", path: "pip" } });
  await c.call("asset_import", { workspaceId: WS, assetId: "mug", source: { library: "characters", path: "props/mug.png" } });
}, 60_000);

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

describe("interactions over MCP", () => {
  it("lists, describes and checks interactions; defines a custom one", async () => {
    const caps = (await c.call("engine_capabilities")).data;
    expect(caps.interactions.tools).toEqual(["interaction_list", "interaction_check", "interaction_define", "interaction_apply", "interaction_inspect"]);
    const list = await ok("interaction_list", { library: "interactions" });
    expect(list.interactions.map((x: any) => x.id)).toEqual(expect.arrayContaining(["handshake", "hug", "high_five", "give_object", "receive_object", "push"]));
    expect(list.packages.map((p: any) => p.interactionId)).toContain("professor_greeting");
    const hs = await ok("interaction_list", { interactionId: "handshake" });
    expect(hs.interaction.actors).toBe(2);
    expect(hs.interaction.channels.owns.a.arms).toEqual(["right (params.hand)"]);
    const chk = await ok("interaction_check", { interaction: "handshake", actors: [{ character: "pip" }, { character: "pip", scale: 0.7 }] });
    expect(chk.compatible).toBe(true);
    expect(chk.fit.unit).toBe("px");
    const def = await ok("interaction_define", { source: { library: "interactions", path: "professor_greeting.json" } });
    expect(def.interaction.id).toBe("professor_greeting");
    expect((await err("interaction_define", { definition: { id: "hug", roles: [], phases: [] } })).code).toBe("INTERACTION_INVALID");
    expect((await err("interaction_list", { interactionId: "tango" })).code).toBe("INTERACTION_NOT_FOUND");
  });

  it("applies, edits, inspects and removes interactions between placed characters", async () => {
    await ok("scene_create", { sceneId: "s", canvas: { width: 480, height: 270, fps: 12, background: "#cfe8f7" }, duration: 120 });
    await ok("character_add", { sceneId: "s", character: { id: "a", character: "pip", x: 150, y: 250, scale: 0.5, props: [{ id: "mug", asset: "mug", socket: "rightHand", scale: 0.3 }] } });
    await ok("character_add", { sceneId: "s", character: { id: "b", character: "pip", x: 330, y: 250, scale: 0.45, facing: "left" } });
    const chk = await ok("interaction_check", { sceneId: "s", interaction: "give_object", actors: ["a", "b"], params: { object: "mug" } });
    expect(chk.compatible).toBe(true);
    const r = await ok("interaction_apply", {
      sceneId: "s",
      operations: [
        { type: "add", interaction: { interaction: "handshake", actors: ["a", "b"], start: 0.5 } },
        { type: "add", interaction: { interaction: "give_object", actors: ["a", "b"], start: 4, params: { object: "mug" } } },
      ],
    });
    expect(r.interactions.map((x: any) => x.id)).toEqual(["ix1", "ix2"]);
    expect(r.interactions[1].transfer).toMatchObject({ object: "mug", from: "a", to: "b" });
    expect(r.objects[0].owners.map((o: any) => o.actor)).toEqual(["a", "b"]);
    // talk keeps working during the interaction; a walk during it is a structured conflict
    await ok("character_actions", { sceneId: "s", character: "b", operations: [{ type: "add", action: { action: "talk", start: 1, duration: 2 } }] });
    const conflict = await err("character_actions", { sceneId: "s", character: "b", operations: [{ type: "add", action: { action: "walk", start: 1, duration: 1, direction: "right" } }] });
    expect(conflict.code).toBe("ACTION_CONFLICT");
    expect(conflict.details.issues[0].details.interactions).toEqual(["ix1"]);
    // inspect at a contact frame: measured grip distance between the hands
    const c1 = r.interactions[0].contacts[0];
    const f = Math.round(((c1.contactStart + c1.contactEnd) / 2) * 12);
    const ins = await ok("interaction_inspect", { sceneId: "s", frame: f });
    expect(ins.atFrame.interactions[0].id).toBe("ix1");
    expect(ins.measured.hands).toHaveLength(2);
    expect(ins.measured.hands[0].distanceToPartnerHand).toBeLessThan(1);
    // edit: move the handover later; remove the handshake
    await ok("interaction_apply", { sceneId: "s", operations: [{ type: "update", id: "ix2", patch: { start: 5 } }, { type: "remove", id: "ix1" }] });
    const ins2 = await ok("interaction_inspect", { sceneId: "s" });
    expect(ins2.interactions.map((x: any) => [x.id, x.start])).toEqual([["ix2", 5]]);
    // removing a character in an interaction needs removeInteractions
    expect((await err("character_remove", { sceneId: "s", id: "b" })).code).toBe("CHARACTER_IN_INTERACTION");
    const rm = await ok("character_remove", { sceneId: "s", id: "b", removeInteractions: true });
    expect(rm.removedInteractions).toEqual(["ix2"]);
    expect((await err("interaction_apply", { sceneId: "s", operations: [{ type: "add", interaction: { interaction: "handshake", actors: ["a", "b"], start: 1 } }] })).code).toBe("CHARACTER_NOT_FOUND");
  });
});
