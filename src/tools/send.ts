import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendMessage, sendSchema } from "../send.js";
import { z } from "zod";
import { listBusinessChats } from "../business.js";

export function registerSendTool(server: McpServer) {
  server.tool(
    "send",
    "Send text to a person or an existing Apple Messages for Business conversation through Messages on the Mac Studio. For Apple Support or another business, first call list_business_chats and pass its exact send_to value as to. Business urn:biz addresses and exact business chat GUIDs are supported; the existing conversation is reused, not a guessed phone number. To contact a business for the first time, open its official Messages entry point on your Apple device and let the thread sync first. External action: use only when the user authorizes this message and recipient. No groups, attachments, or SMS phone-number fallback. Supply a unique request_id UUID and reuse it for retries. dry_run checks account access or exact business chat resolution without sending. Submitted means Messages accepted the command, not confirmed delivery. Never automatically retry with a new request_id after an uncertain result.",
    sendSchema.shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (params) => {
      try {
        const result = await sendMessage(params);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.status === "unknown" || result.status === "not_sent" };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Send failed." }], isError: true };
      }
    },
  );

  server.tool(
    "list_business_chats",
    "Find existing Apple Messages for Business conversations, including Apple Support. Returns business_name, send_to, exact chat_guid, and history_chat_id. Use send_to as the send tool's to field and get_conversation(chat_id=history_chat_id) to read context. Does not send or create a conversation. Some business threads are stored with service SMS; send_to still selects the exact business thread.",
    {
      query: z.string().max(200).optional().describe("Business name or urn:biz address substring, such as Apple."),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (params) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(listBusinessChats(params.query, params.limit, params.offset), null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : "Business chat lookup failed." }], isError: true };
      }
    },
  );
}
