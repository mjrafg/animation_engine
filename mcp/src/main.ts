/**
 * video-engine-mcp — MCP server exposing the deterministic 2D video engine.
 *
 *   video-engine-mcp [--root DIR] [--workspace ID] [--library name=/dir] [--log FILE]   run on stdio
 *   video-engine-mcp --version
 *   video-engine-mcp --self-test [--root DIR]      health check incl. a real render; exit code 0/1
 *   video-engine-mcp --list-tools                  print tool definitions (JSON) and exit
 *
 * stdout carries only MCP JSON-RPC. Diagnostics go to the JSONL log file (see context.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { engineVersion } from "../../src/capabilities.js";
import { ServerContext, configFrom } from "./context.js";
import { createVideoEngineServer, listToolDefinitions } from "./server.js";
import { SERVER_NAME, SERVER_VERSION, healthCheck } from "./tools.js";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    const e = engineVersion();
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION} (engine ${e.name} ${e.version}, node ${process.version})\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "usage: video-engine-mcp [--root DIR] [--workspace ID] [--library name=DIR] [--log FILE] | --version | --self-test | --list-tools\n",
    );
    return;
  }
  const config = configFrom(argv, process.env);
  if (argv.includes("--list-tools")) {
    process.stdout.write(JSON.stringify(listToolDefinitions(), null, 2) + "\n");
    return;
  }
  if (argv.includes("--self-test")) {
    const r = await healthCheck({ config }, true);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  const ctx = new ServerContext(config);
  const server = createVideoEngineServer(ctx);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = (reason: string) => {
    if (closing) return;
    closing = true;
    ctx.shutdown();
    ctx.log({ event: "shutdown", reason });
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.stdin.on("close", () => shutdown("stdin closed"));
  process.on("uncaughtException", (e) => ctx.log({ event: "uncaughtException", message: e.message, stack: e.stack }));
  process.on("unhandledRejection", (e) => ctx.log({ event: "unhandledRejection", message: String(e) }));
  await server.connect(transport);
  ctx.log({ event: "start", root: config.root, lockedWorkspace: config.lockedWorkspace ?? null, libraries: Object.keys(config.libraries) });
}

main().catch((e) => {
  process.stderr.write(`video-engine-mcp failed to start: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
