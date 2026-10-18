# Security

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it through [GitHub's private vulnerability reporting](https://github.com/anipotts/imessage-mcp/security/advisories/new).

Do not open a public issue for security vulnerabilities.

## Design

- History database access uses `readonly: true` and `query_only = ON`. Sending never writes to `chat.db`.
- Requested history and contact results are returned to the connected MCP client.
- `send` is an external write action. It passes authorized text to the local Messages app, which communicates through Apple's messaging service.
- Recipient and message content are passed through private temporary UTF-8 files, without interpolation into shell commands or AppleScript source. These files are removed after execution.
- A private local ledger records request IDs, recipient/content hashes, and results. Message bodies are not stored in that ledger. Reusing a request ID prevents another send, including after a restart or uncertain result.
- Business sends require an exact existing `urn:biz:` conversation. Unknown, ambiguous, archived, blocked, or deleting chats are rejected. No phone-number fallback is used for business threads.
- The tool description requires user authorization. The server does not independently collect user approval; the MCP client must enforce its own approval policy.
- SQL queries use bound parameters for user input.
- HTTP/SSE hosting supports `IMESSAGE_API_TOKEN` bearer authentication. Bind to loopback when placing the server behind an authenticated tunnel or reverse proxy.
