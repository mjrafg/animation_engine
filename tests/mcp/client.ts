/**
 * Minimal stdio MCP client that behaves like Tandem's integrations/mcpClient.ts StdioConn:
 * newline-delimited JSON-RPC, protocolVersion 2025-03-26, env = PATH/HOME + integration env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export const SERVER = path.resolve(__dirname, "../../dist/video-engine-mcp.mjs");

export class McpStdioClient {
  proc: ChildProcess;
  private buf = "";
  private id = 10;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  stderr = "";
  exited: Promise<number | null>;

  constructor(env: Record<string, string>, args: string[] = []) {
    this.proc = spawn(process.execPath, [SERVER, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (c: string) => this.onData(c));
    this.proc.stderr!.on("data", (c) => (this.stderr += c));
    this.exited = new Promise((r) => this.proc.on("close", (code) => r(code)));
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line); // the server must never print non-JSON to stdout
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
        else p.resolve(msg.result);
      }
    }
  }

  rpc(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  writeRaw(line: string) {
    this.proc.stdin!.write(line + "\n");
  }

  async initialize() {
    const r = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tandem", version: "1" } });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return r;
  }

  /** tools/call, returning the parsed JSON text and the isError flag. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; data: any; text: string }> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = (r.content ?? []).map((c: any) => c.text).join("\n");
    return { ok: !r.isError, data: JSON.parse(text), text };
  }

  /** Like call, but throws with the structured error if the tool failed. */
  async ok(name: string, args: Record<string, unknown> = {}) {
    const r = await this.call(name, args);
    if (!r.ok) throw new Error(`${name} failed: ${r.text}`);
    return r.data;
  }

  close() {
    this.proc.kill("SIGTERM");
    return this.exited;
  }
}
