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

```powershell
npm.cmd run service
```

Create a separate Matrix account for the agent, then run the service. The first run uses Matrix OAuth device authorization. Follow the verification URL and approve the login in a browser. The service then syncs its joined rooms and replies to messages that start with `!ai `, for example:

```text
!ai Summarize the latest news I pasted here.
```

Invite the agent account shown at startup to a room, or start a direct chat with it from your phone. Responses are sent back to the same room. Per-room conversation context is held in memory for the lifetime of the service.

The OAuth client registration ID is cached under `data/matrix-client.json`. Access and refresh tokens are stored in `data/matrix-session.json`, and the E2EE IndexedDB state is snapshotted to `data/matrix-crypto-<device-id>.bin`. These files are ignored by Git and created with owner-only permissions where supported. On restart, the service refreshes the saved token and restores the same encrypted device; if the refresh token is revoked or the crypto snapshot is missing, it starts device authorization again. Keep the `data` directory private and include it in backups if you need to preserve the Matrix device.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_BASE_URL` | `http://127.0.0.1:9931` | OpenAI-compatible server base URL, without `/v1` |
| `OPENAI_MODEL` | `local-model` | Model name |
| `OPENAI_API_KEY` | unset | Optional Bearer token for the LLM server |
| `SYSTEM_PROMPT` | `You are a helpful assistant.` | LLM system message |
| `MATRIX_HOMESERVER_URL` | `https://matrix.org` | Matrix homeserver URL |
| `MATRIX_OAUTH_CLIENT_ID` | auto registered and cached | Optional pre-registered OAuth client ID |
| `MATRIX_TRIGGER` | `!ai ` | Prefix required to send a room message to the LLM |

Matrix.org accounts are managed through Matrix Authentication Service (OAuth); this client uses the SDK's OAuth device flow. Other homeservers must support OAuth device authorization for this sign-in mode.
