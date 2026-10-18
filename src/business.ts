import type Database from "better-sqlite3";
import { getDb } from "./db.js";

const BUSINESS_TARGET = /^(?:(?:any|iMessage|SMS);-;)?urn:biz:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BusinessChat = {
  chat_guid: string;
  chat_identifier: string;
  business_name: string | null;
  stored_service: string | null;
  is_archived: number;
  is_blackholed: number;
  is_deleting_incoming_messages: number;
};

export function isBusinessTarget(value: string): boolean {
  return BUSINESS_TARGET.test(value);
}

const SELECT_BUSINESS = `SELECT guid AS chat_guid, chat_identifier,
  display_name AS business_name, service_name AS stored_service,
  COALESCE(is_archived, 0) AS is_archived,
  COALESCE(is_blackholed, 0) AS is_blackholed,
  COALESCE(is_deleting_incoming_messages, 0) AS is_deleting_incoming_messages FROM chat`;

/** Resolve only an existing exact business conversation. Never create a guessed recipient. */
export function resolveBusinessChat(target: string, db: Database.Database = getDb()): BusinessChat {
  if (!isBusinessTarget(target)) throw new Error("Invalid Messages for Business address.");
  const rows = (target.includes(";-;")
    ? db.prepare(`${SELECT_BUSINESS} WHERE guid = ?`).all(target)
    : db.prepare(`${SELECT_BUSINESS} WHERE lower(chat_identifier) = lower(?)`).all(target)) as BusinessChat[];
  if (rows.length === 0) throw new Error("Business conversation not found on this Mac. Open the business's official Messages entry point on your Apple device and let the conversation sync, then call list_business_chats.");
  if (rows.length !== 1) throw new Error("Multiple business conversations match this address. Use the exact chat_guid from list_business_chats.");
  const chat = rows[0];
  if (chat.is_archived || chat.is_blackholed || chat.is_deleting_incoming_messages) throw new Error("This business conversation is archived, blocked, or being deleted. Reopen it in Messages before sending.");
  return chat;
}

export function listBusinessChats(query = "", limit = 50, offset = 0, db: Database.Database = getDb()) {
  const rows = db.prepare(`${SELECT_BUSINESS}
    WHERE chat_identifier LIKE 'urn:biz:%'
      AND (instr(lower(COALESCE(display_name, '')), lower(@query)) > 0
        OR instr(lower(chat_identifier), lower(@query)) > 0)
    ORDER BY COALESCE(display_name, ''), ROWID
    LIMIT @limit OFFSET @offset`).all({ query, limit: limit + 1, offset }) as BusinessChat[];
  return {
    chats: rows.slice(0, limit).map((chat) => ({
      ...chat,
      send_to: chat.chat_guid,
      history_chat_id: chat.chat_identifier,
      available_for_send: !chat.is_archived && !chat.is_blackholed && !chat.is_deleting_incoming_messages,
    })),
    has_more: rows.length > limit,
    next_offset: rows.length > limit ? offset + limit : null,
    instructions: "Use send_to as the send tool's to field. Read history with get_conversation(chat_id=history_chat_id). Business conversations must already exist on this Mac. A successful dry run verifies exact chat resolution, not business availability or delivery. stored_service may say SMS for a business thread; the sender uses the existing chat itself and never substitutes an SMS phone number.",
  };
}
