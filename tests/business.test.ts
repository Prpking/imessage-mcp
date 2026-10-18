import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { isBusinessTarget, listBusinessChats, resolveBusinessChat } from "../src/business.js";
import { sendMessage, sendSchema } from "../src/send.js";
import { randomUUID } from "node:crypto";

const address = "urn:biz:11111111-2222-4333-8444-555555555555";
const guid = `any;-;${address}`;
const dbs: Database.Database[] = [];
function fixture() {
  const db = new Database(":memory:");
  dbs.push(db);
  db.exec(`CREATE TABLE chat (guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT,
    is_archived INTEGER DEFAULT 0, is_blackholed INTEGER DEFAULT 0, is_deleting_incoming_messages INTEGER DEFAULT 0)`);
  db.prepare("INSERT INTO chat (guid,chat_identifier,display_name,service_name) VALUES (?,?,?,?)").run(guid, address, "Apple", "SMS");
  db.prepare("INSERT INTO chat (guid,chat_identifier,display_name,service_name) VALUES (?,?,?,?)").run("any;-;+12025550123", "+12025550123", "A person", "iMessage");
  return db;
}
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe("Messages for Business targeting", () => {
  it("accepts exact business URNs and chat GUIDs, while rejecting malformed or injected identifiers", () => {
    for (const to of [address, guid]) {
      expect(isBusinessTarget(to)).toBe(true);
      expect(sendSchema.parse({ to, text: "Hello", request_id: randomUUID() }).to).toBe(to);
    }
    for (const to of ["Apple", "urn:biz:missing", `${address}\nreturn 1`, `${guid}; anything`, "any;+;chat123", "urn:biz:' OR 1=1 --"]) {
      expect(isBusinessTarget(to)).toBe(false);
    }
  });

  it("preserves the exact business chat even when chat.db labels its service SMS", () => {
    const db = fixture();
    expect(resolveBusinessChat(address, db).chat_guid).toBe(guid);
    expect(resolveBusinessChat(guid, db).stored_service).toBe("SMS");
    const found = listBusinessChats("Apple", 50, 0, db);
    expect(found.chats).toHaveLength(1);
    expect(found.chats[0].send_to).toBe(guid);
    expect(found.chats[0].history_chat_id).toBe(address);
    expect(found.chats[0].available_for_send).toBe(true);
  });

  it("never guesses or creates a missing business and refuses ambiguous address matches", () => {
    const db = fixture();
    expect(() => resolveBusinessChat("urn:biz:00000000-0000-0000-0000-000000000000", db)).toThrow("not found");
    db.prepare("INSERT INTO chat (guid,chat_identifier,display_name,service_name) VALUES (?,?,?,?)").run(`iMessage;-;${address}`, address, "Apple duplicate", "iMessage");
    expect(() => resolveBusinessChat(address, db)).toThrow("Multiple business conversations");
    expect(resolveBusinessChat(guid, db).chat_guid).toBe(guid);
  });

  it("refuses archived, blocked, and deleting conversations", () => {
    const db = fixture();
    for (const column of ["is_archived", "is_blackholed", "is_deleting_incoming_messages"]) {
      db.prepare(`UPDATE chat SET ${column}=1 WHERE guid=?`).run(guid);
      expect(() => resolveBusinessChat(guid, db)).toThrow("archived, blocked, or being deleted");
      expect(listBusinessChats("Apple", 50, 0, db).chats[0].available_for_send).toBe(false);
      db.prepare(`UPDATE chat SET ${column}=0 WHERE guid=?`).run(guid);
    }
  });

  it("returns paginated business chats and treats search syntax literally", () => {
    const db = fixture();
    db.prepare("INSERT INTO chat (guid,chat_identifier,display_name,service_name) VALUES (?,?,?,?)").run("any;-;urn:biz:00000000-0000-0000-0000-000000000001", "urn:biz:00000000-0000-0000-0000-000000000001", "Other", "iMessage");
    expect(listBusinessChats("", 1, 0, db).next_offset).toBe(1);
    expect(listBusinessChats("", 1, 1, db).has_more).toBe(false);
    expect(listBusinessChats("' OR 1=1 --", 50, 0, db).chats).toHaveLength(0);
    expect(listBusinessChats("%", 50, 0, db).chats).toHaveLength(0);
  });

  it("routes a business dry run without consuming a send attempt", async () => {
    const calls: unknown[] = [];
    const result = await sendMessage({ to: guid, text: "Dry run", request_id: randomUUID(), dry_run: true }, async (...args) => { calls.push(args); });
    expect(result.status).toBe("ready");
    expect(result.detail).toContain("Messages for Business");
    expect(calls).toEqual([[guid, "Dry run", true]]);
  });
});
