import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isBusinessTarget, resolveBusinessChat } from "./business.js";

class SendPreflightError extends Error {}

export const sendSchema = z.object({
  to: z.string().trim().refine(
    (value) => /^\+[1-9]\d{7,14}$/.test(value) || /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value) || isBusinessTarget(value),
    "Use one exact international phone number, email, or existing Messages for Business urn:biz address/chat GUID from list_business_chats. Names and groups are not supported.",
  ).describe("Exact phone/email for a person, or send_to from list_business_chats for an existing Apple Messages for Business thread."),
  text: z.string().min(1).max(20000).refine((value) => value.trim().length > 0 && !value.includes("\0"), "Message must contain text and no NUL characters.").describe("Message body to send to the authorized recipient."),
  request_id: z.string().uuid().describe("Unique UUID for this send. Reuse this exact UUID when retrying the same message to prevent duplicates."),
  dry_run: z.boolean().default(false).describe("Check inputs and Messages access without sending. For a business, also resolve and verify the exact existing chat. Does not verify business availability or delivery."),
});

export const SEND_SCRIPT = `on run argv
  set recipientAddress to read (POSIX file (item 1 of argv)) as «class utf8»
  set messageText to read (POSIX file (item 2 of argv)) as «class utf8»
  tell application "Messages"
    if item 4 of argv is "business" then
      set targetChat to chat id recipientAddress
      if (id of targetChat) is not recipientAddress then error "Resolved business chat does not match the requested chat."
      set businessName to name of targetChat
      if item 3 of argv is "true" then return "READY"
      log "IMESSAGE_SEND_DISPATCH_STARTED"
      send messageText to targetChat
    else
      set targetAccount to first account whose service type is iMessage
      if not (enabled of targetAccount) then error "The iMessage account is disabled."
      set targetParticipant to participant recipientAddress of targetAccount
      if item 3 of argv is "true" then return "READY"
      log "IMESSAGE_SEND_DISPATCH_STARTED"
      send messageText to targetParticipant
    end if
  end tell
  return "SUBMITTED"
end run`;

export type SendInput = z.input<typeof sendSchema>;
export type SendResult = { status: "ready" | "submitted" | "not_sent" | "unknown" | "in_progress"; to: string; request_id: string; detail: string; replayed?: boolean };
type StoredResult = { fingerprint: string; result: SendResult };
type Runner = (to: string, text: string, dryRun: boolean) => Promise<void>;

/** User data is read from private files, never interpolated into executable script or shell code. */
export async function runMessagesScript(to: string, text: string, dryRun: boolean): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Sending requires macOS Messages.");
  const business = isBusinessTarget(to);
  let scriptTarget = to;
  if (business) {
    try { scriptTarget = resolveBusinessChat(to).chat_guid; }
    catch (error) { throw new SendPreflightError(error instanceof Error ? error.message : "Business chat resolution failed."); }
  }
  const dir = await mkdtemp(join(tmpdir(), "imessage-send-"));
  try {
    const recipientFile = join(dir, "recipient");
    const textFile = join(dir, "message");
    await writeFile(recipientFile, scriptTarget, { mode: 0o600 });
    await writeFile(textFile, text, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", SEND_SCRIPT, recipientFile, textFile, String(dryRun), business ? "business" : "person"], { stdio: ["ignore", "pipe", "pipe"], shell: false });
      let output = "";
      let errors = "";
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30000);
      child.stdout.setEncoding("utf8").on("data", (data: string) => { output += data; });
      child.stderr.setEncoding("utf8").on("data", (data: string) => { errors += data; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        const failure = timedOut ? "Messages timed out after 30 seconds." : errors.replace("IMESSAGE_SEND_DISPATCH_STARTED", "").trim() || "Messages exited without success.";
        if (timedOut || code !== 0) return reject(errors.includes("IMESSAGE_SEND_DISPATCH_STARTED") ? new Error(failure) : new SendPreflightError(failure));
        if (output.trim() !== (dryRun ? "READY" : "SUBMITTED")) return reject(new Error("Messages returned an unexpected result."));
        resolve();
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Atomic request creation prevents concurrent or post-restart retries from sending twice. */
export async function sendMessage(input: SendInput, runner: Runner = runMessagesScript, ledgerDir = join(homedir(), ".local", "state", "imessage-mcp", "sends")): Promise<SendResult> {
  const params = sendSchema.parse(input);
  const base = { to: params.to, request_id: params.request_id };
  if (params.dry_run) {
    await runner(params.to, params.text, true);
    return { ...base, status: "ready", detail: isBusinessTarget(params.to) ? "Validation and exact existing Messages for Business chat resolution passed. Nothing sent. Business session availability and delivery are unverified." : "Validation and Messages iMessage account access passed. Nothing sent. Recipient registration and delivery are unverified." };
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([params.to, params.text])).digest("hex");
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  const path = join(ledgerDir, `${params.request_id}.json`);
  const initial: StoredResult = { fingerprint, result: { ...base, status: "in_progress", detail: "Send attempt recorded. If this persists after a restart, check the conversation before making a new request. Reusing this request_id will not send again." } };
  try {
    await writeFile(path, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stored: StoredResult = JSON.parse(await readFile(path, "utf8"));
    if (stored.fingerprint !== fingerprint) throw new Error("request_id was already used for a different recipient or message. Nothing sent.");
    return { ...stored.result, replayed: true };
  }
  let result: SendResult;
  try {
    await runner(params.to, params.text, false);
    result = { ...base, status: "submitted", detail: isBusinessTarget(params.to) ? "Messages accepted the send command for the exact existing business conversation. Delivery is not confirmed." : "Messages accepted the iMessage send command. Delivery is not confirmed." };
  } catch (error) {
    // A timeout or AppleEvent failure can occur after submission. Never retry automatically.
    result = error instanceof SendPreflightError
      ? { ...base, status: "not_sent", detail: `Messages did not reach the send command: ${error.message} Fix this condition and use a new request_id for a deliberate send attempt.` }
      : { ...base, status: "unknown", detail: `Send could not be confirmed: ${error instanceof Error ? error.message : "Messages error"} Check the conversation before making a new request. This request_id will not send again.` };
  }
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, JSON.stringify({ fingerprint, result }), { mode: 0o600 });
  await rename(tempPath, path);
  return result;
}
