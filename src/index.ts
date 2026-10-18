// imessage-mcp -- iMessage MCP server
//
// 28 tools for searching, analyzing, and sending iMessages.
// Reads ~/Library/Messages/chat.db via better-sqlite3 (readonly).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerAttachmentTools } from "./tools/attachments.js";
import { registerReactionTools } from "./tools/reactions.js";
import { registerReceiptTools } from "./tools/receipts.js";
import { registerThreadTools } from "./tools/threads.js";
import { registerEditTools } from "./tools/edits.js";
import { registerEffectTools } from "./tools/effects.js";
import { registerMemoryTools } from "./tools/memories.js";
import { registerPatternTools } from "./tools/patterns.js";
import { registerWrappedTools } from "./tools/wrapped.js";
import { registerSyncTools } from "./tools/sync.js";
import { registerSendTool } from "./tools/send.js";
import { registerHelp } from "./help.js";
import { parseSyncMode, startWatcher, stopWatcher } from "./watcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

/** Create the McpServer with all tools registered. */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "imessage-mcp",
      version: pkg.version,
    },
    {
      instructions: `iMessage MCP: access to message history and an authorized iMessage send tool on macOS.

Use this server's tools whenever the user asks about their texts, messages, iMessages, conversations, or messaging history. This includes: "search my messages for X", "what did I text about Y", "show my conversation with Z", "who do I text the most", "when did I last talk to", etc.

Important: On macOS, when a user says "messages" they almost always mean their iMessage/SMS history, not the current conversation. Use search_messages for history queries. Use send only when the user authorizes a specific message and recipient. For people, resolve a name to an exact phone number or email. For Apple Support or another Messages for Business conversation, call list_business_chats and pass its send_to value to send. Existing business threads with urn:biz addresses are supported. Reuse request_id for retries. Submitted does not confirm delivery. If no results are found, mention that you searched their iMessage history and ask if they meant something else.

28 tools available: send, list_business_chats, search, conversations, contacts, analytics, heatmaps, streaks, reactions, read receipts, reply threads, edited/unsent messages, effects, yearly wrapped, sync, and more. Call help() for the full guide.`,
    },
  );

  // Register all tool modules
  registerMessageTools(server);
  registerSendTool(server);
  registerContactTools(server);
  registerAnalyticsTools(server);
  registerGroupTools(server);
  registerAttachmentTools(server);
  registerReactionTools(server);
  registerReceiptTools(server);
  registerThreadTools(server);
  registerEditTools(server);
  registerEffectTools(server);
  registerMemoryTools(server);
  registerPatternTools(server);
  registerWrappedTools(server);
  registerSyncTools(server);
  registerHelp(server);

  return server;
}

/** Start the server with stdio transport (default). */
export async function startStdio(): Promise<void> {
  const server = createServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start watcher if configured (after transport is connected)
  const syncMode = parseSyncMode(process.env.IMESSAGE_SYNC);
  if (syncMode !== "off") {
    startWatcher(server, syncMode);
  }

  // Graceful shutdown
  process.on("SIGINT", () => {
    stopWatcher();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopWatcher();
    process.exit(0);
  });
}
