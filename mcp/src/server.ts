/**
 * Transport-agnostic MCP server: tools/list and tools/call over the tool table. The transport
 * (stdio today, Streamable HTTP later) is attached by the caller, so tool semantics never depend
 * on it.
 *
 * Every result is one JSON text block that starts with a human-readable `summary`. Failures are
 * returned as MCP tool errors (isError: true) whose text is
 *   {"error":{"code":"LAYER_NOT_FOUND","message":"...","details":{...}}}
 * with stable codes, so an agent can read the problem and repair its request.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EngineError } from "../../src/errors.js";
import type { ServerContext } from "./context.js";
import { SERVER_NAME, SERVER_VERSION, TOOL_DEFS, type ToolDef } from "./tools.js";

/** Self-contained JSON Schema (no $ref/$defs) for a tool's arguments. */
export function inputSchemaOf(t: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(t.args, { io: "input", reused: "inline", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  const text = JSON.stringify(s);
  if (text.includes('"$ref"') || text.includes('"$defs"')) throw new Error(`tool ${t.name}: schema must be self-contained`);
  return s;
}

export function listToolDefinitions() {
  return TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchemaOf(t) }));
}

export interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

function errorResponse(code: string, message: string, details?: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, message, ...(details && Object.keys(details).length ? { details } : {}) } }) }],
    isError: true,
  };
}

/** Removes big/opaque values (base64 payloads) from arguments before logging. */
function safeArgs(args: unknown): unknown {
  return JSON.parse(
    JSON.stringify(args ?? {}, (k, v) => (k === "base64" && typeof v === "string" ? `<${v.length} base64 chars>` : v)),
  );
}

export async function callTool(ctx: ServerContext, name: string, rawArgs: unknown): Promise<ToolResponse> {
  const t0 = Date.now();
  const tool = TOOL_DEFS.find((t) => t.name === name);
  const finish = (res: ToolResponse, extra: Record<string, unknown>) => {
    ctx.log({ tool: name, args: safeArgs(rawArgs), durationMs: Date.now() - t0, ...extra });
    return res;
  };
  if (!tool) {
    return finish(errorResponse("UNKNOWN_TOOL", `Unknown tool "${name}"`, { available: TOOL_DEFS.map((t) => t.name) }), { ok: false, errorCode: "UNKNOWN_TOOL" });
  }
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message, code: i.code }));
    const first = issues[0];
    return finish(
      errorResponse("INVALID_ARGUMENT", `Invalid arguments for ${name}: ${first.path.join(".") || "(root)"}: ${first.message}`, { issues }),
      { ok: false, errorCode: "INVALID_ARGUMENT" },
    );
  }
  try {
    const result = await tool.handler(ctx, parsed.data, rawArgs);
    const text = JSON.stringify(result);
    const artifacts = text.match(/"artifactId":"[^"]+"/g)?.map((s) => s.slice(14, -1));
    return finish({ content: [{ type: "text", text }] }, { ok: true, summary: result.summary, ...(artifacts ? { artifacts: [...new Set(artifacts)] } : {}) });
  } catch (e) {
    if (e instanceof EngineError) {
      return finish(errorResponse(e.code, e.message, e.details), { ok: false, errorCode: e.code, message: e.message });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return finish(errorResponse("INTERNAL_ERROR", msg), { ok: false, errorCode: "INTERNAL_ERROR", message: msg, stack: e instanceof Error ? e.stack : undefined });
  }
}

export function createVideoEngineServer(ctx: ServerContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Deterministic 2D video engine. Workflow: engine_capabilities -> workspace_create/open -> asset_import/asset_process -> scene_create -> layer_add -> timeline_apply -> measure_layout / render_preview (open viewPath to look) -> adjust with layer_update -> render_video_start + render_video_status. Coordinates: canvas px, origin top-left, +y down, degrees clockwise; x/y = pivot position; z = global draw order independent of parent.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(ctx, req.params.name, req.params.arguments));
  return server;
}
