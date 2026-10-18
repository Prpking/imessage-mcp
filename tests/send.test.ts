import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendMessage, SEND_SCRIPT, sendSchema } from "../src/send.js";
import { registerSendTool } from "../src/tools/send.js";

let ledger: string;
beforeEach(async () => { ledger = await mkdtemp(join(tmpdir(), "send-test-")); });
afterEach(async () => { await rm(ledger, { recursive: true, force: true }); });
const input = () => ({ to: "+12025550123", text: "Hello", request_id: randomUUID() });

describe("iMessage sending", () => {
  it("rejects ambiguous recipients, malformed numbers and empty messages before execution", async () => {
    const runner = vi.fn();
    for (const to of ["Parker", "2025550123", "+1", "+12025550123,+12025550124", "a@example.com\nb@example.com"]) {
      await expect(sendMessage({ ...input(), to }, runner, ledger)).rejects.toThrow();
    }
    for (const text of ["", "  ", "hello\0world"]) {
      await expect(sendMessage({ ...input(), text }, runner, ledger)).rejects.toThrow();
    }
    await expect(sendMessage({ ...input(), request_id: "../../escape" }, runner, ledger)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("passes quotes, newlines, Unicode and shell syntax as unmodified data", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const params = { ...input(), text: '"hello"\n$(touch /tmp/never) \\ 😀', to: "parker@example.com" };
    const result = await sendMessage(params, runner, ledger);
    expect(result.status).toBe("submitted");
    expect(runner).toHaveBeenCalledWith(params.to, params.text, false);
    expect(SEND_SCRIPT).not.toContain(params.text);
    expect(SEND_SCRIPT).toContain('first account whose service type is iMessage');
    expect(SEND_SCRIPT).not.toContain('SMS');
    expect((await readFile(join(ledger, `${params.request_id}.json`), "utf8"))).not.toContain(params.text);
  });

  it("dry-run never sends, writes a ledger entry, or consumes the request UUID", async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    const params = input();
    expect((await sendMessage({ ...params, dry_run: true }, runner, ledger)).status).toBe("ready");
    expect(runner).toHaveBeenLastCalledWith(params.to, params.text, true);
    expect(await readdir(ledger)).toEqual([]);
    await sendMessage(params, runner, ledger);
    expect(runner).toHaveBeenLastCalledWith(params.to, params.text, false);
  });

  it("deduplicates retries across calls and rejects changed content", async () => {
    const params = input();
    const runner = vi.fn().mockResolvedValue(undefined);
    await sendMessage(params, runner, ledger);
    expect((await sendMessage(params, runner, ledger)).replayed).toBe(true);
    await expect(sendMessage({ ...params, text: "changed" }, runner, ledger)).rejects.toThrow("different recipient or message");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("blocks a concurrent duplicate while the first send is pending", async () => {
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const runner = vi.fn(() => { started(); return new Promise<void>((resolve) => { finish = resolve; }); });
    const params = input();
    const first = sendMessage(params, runner, ledger);
    await ready;
    expect((await sendMessage(params, runner, ledger)).status).toBe("in_progress");
    finish();
    await first;
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("records an uncertain attempt and never retries it automatically", async () => {
    const params = input();
    const runner = vi.fn().mockRejectedValue(new Error("Messages timed out"));
    expect((await sendMessage(params, runner, ledger)).status).toBe("unknown");
    expect((await sendMessage(params, runner, ledger)).status).toBe("unknown");
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("advertises send as an external action and validates calls through MCP", async () => {
    const server = new McpServer({ name: "send-test", version: "1" });
    registerSendTool(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(b);
    await client.connect(a);
    try {
      const tools = await client.listTools();
      expect(tools.tools[0].name).toBe("send");
      expect(tools.tools[0].annotations?.readOnlyHint).toBe(false);
      expect(tools.tools[0].annotations?.openWorldHint).toBe(true);
      expect(tools.tools[0].inputSchema.required).toEqual(["to", "text", "request_id"]);
      const result = await client.callTool({ name: "send", arguments: { ...input(), to: "ambiguous name" } });
      expect(result.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
