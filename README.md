# OpenAI-compatible TUI and Matrix Chat Agent

TypeScript chat client for OpenAI-compatible APIs, plus an Element/Matrix bridge that lets you chat with the configured LLM from the Element app on your phone.

## Install

```powershell
npm.cmd install
```

## Terminal chat

```powershell
npm.cmd start
```

Use `/clear` to reset conversation history and `/exit` to quit.

## Element / Matrix service

詳しいアカウント作成、初回ログイン、端末認証、暗号化ルームでの利用、トラブル対応は[Matrix セットアップガイド](docs/matrix-setup.md)を参照してください。

```powershell
npm.cmd run service
```

Create a separate Matrix account for the agent, then run the service. The first run uses Matrix OAuth device authorization. Follow the verification URL and approve the login in a browser. The service syncs its joined rooms and replies to every other user's message in rooms with at most two joined members. In rooms with three or more joined members, use Element's mention picker to mention the agent; it replies only to mentioned messages. For example, in a two-person room:

```text
こんにちは
```

Invite the agent account shown at startup to a room, or start a direct chat with it from your phone. Responses are sent back to the same room. Per-room conversation context is held in memory for the lifetime of the service.

Messages sent before the current service process starts are ignored. Eligible new messages receive an `👀` reaction before processing; if the agent already reacted with `👀`, it skips that message.

Matrix commands: `/new` clears that room's in-memory conversation history, `/status` reports the selected model and token usage, and `/model` lists available model IDs. Use `/model <model-id>` to switch models for this running service. Unknown slash commands return a command help message.

The OAuth client registration ID is cached under `data/matrix-client.json`. Access and refresh tokens are stored in `data/matrix-session.json`, and the E2EE IndexedDB state is snapshotted to `data/matrix-crypto-<device-id>.bin`. These files are ignored by Git and created with owner-only permissions where supported. On restart, the service refreshes the saved token and restores the same encrypted device; if the refresh token is revoked or the crypto snapshot is missing, it starts device authorization again. Keep the `data` directory private and include it in backups if you need to preserve the Matrix device.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `http://127.0.0.1:9931` | OpenAI-compatible server base URL, without `/v1` |
| `OPENAI_MODEL` | `local-model` | Model name |
| `OPENAI_API_KEY` | unset | Optional Bearer token for the LLM server |
| `OPENAI_STARTUP_WAIT_SECONDS` | `120` | Seconds to wait before retrying after `503 no upstreams available` |
| `MCP_MAX_TOOL_ROUNDS` | `8` | Maximum number of consecutive LLM tool-call rounds per user message |
| `SYSTEM_PROMPT` | `You are a helpful assistant.` | LLM system message |
| `SYSTEM_PROMPT_FILE` | unset | UTF-8 file containing the system prompt; used when `SYSTEM_PROMPT` is unset |
| `MATRIX_HOMESERVER_URL` | `https://matrix.org` | Matrix homeserver URL |
| `MATRIX_OAUTH_CLIENT_ID` | auto registered and cached | Optional pre-registered OAuth client ID |

Matrix.org accounts are managed through Matrix Authentication Service (OAuth); this client uses the SDK's OAuth device flow. Other homeservers must support OAuth device authorization for this sign-in mode.
