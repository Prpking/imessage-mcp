# Sending messages

The `mac-studio` branch adds `send` and `list_business_chats` to the v1.5 server. The service opens message history read-only and sends through local macOS Messages automation.

## Tools

`send` accepts:

| Input | Meaning |
| --- | --- |
| `to` | One exact international phone number, email address, or existing business `urn:biz:` address/chat GUID returned by `list_business_chats` |
| `text` | User-authorized message body, up to 20,000 characters |
| `request_id` | A unique UUID for this message; reuse it on retries |
| `dry_run` | Defaults to false; true checks access and targeting without sending |

For people, the server selects the first enabled iMessage account. For business conversations, it resolves the exact existing chat from the local database and addresses that chat directly. It does not guess a business phone number or infer the transport from the database's service label. Some Apple business threads are stored with an SMS label.

`list_business_chats` accepts an optional business-name/address `query`, `limit`, and `offset`. It returns:

- `business_name` for identifying the intended business.
- `send_to` to pass unchanged to `send.to`.
- `history_chat_id` to use with `get_conversation.chat_id`.
- `available_for_send` to show whether the stored thread is archived, blocked, or being deleted.

Find the business, inspect the conversation, and use the selected exact target for the message the user authorized. Names alone are never accepted as send targets. New businesses must first be opened through an official Messages entry point on an Apple device and synced to this Mac. See [Apple's Messages for Business instructions](https://support.apple.com/en-us/102053).

When aggregated through a portal with the `imessage` prefix, these tools are exposed as `imessage_send` and `imessage_list_business_chats`. Refresh client tool definitions after updating the service.

## Results and retries

- `ready`: dry-run checks passed. Nothing sent. Business session availability and delivery remain unverified.
- `submitted`: Messages accepted the send command. Delivery is unverified.
- `not_sent`: execution did not reach the send command. Correct the preflight problem before a deliberate new attempt.
- `unknown`: the send result could not be confirmed. Inspect the conversation before issuing a new request ID.
- `in_progress`: an attempt with this request ID is recorded. It may still be running or may have been interrupted.

The server records each real attempt before invoking Messages. Reusing the same request ID and content returns the recorded result instead of sending again. Reusing the ID for different content is rejected. Dry runs do not consume IDs. Persistent records survive service restarts; uncertain attempts are never retried automatically.

This implementation sends plain text to individual recipients and existing business conversations. It does not create a business relationship, guarantee an active customer-support session, or confirm delivery. Groups and attachments are outside this implementation.

## Local data and validation

The request ledger lives at `~/.local/state/imessage-mcp/sends/`. It stores a content/recipient hash and result, without the message body. Private temporary files hold recipient and body data during AppleScript execution and are then removed.

The deployed implementation passed its TypeScript build, typecheck, and all 63 tests. Live dry runs resolved an existing business conversation both by exact chat GUID and raw business URN, including through the authenticated Portal endpoint. No actual business message was sent during deployment verification; actual submission and delivery remain unverified.
