# OpenAI-compatible TUI Chat

Node.js and TypeScript terminal chat client for an OpenAI-compatible server. Defaults to llama.cpp at `http://127.0.0.1:9931` and streams chat completions.

## Start

```powershell
npm.cmd install
npm.cmd start
```

Use `/clear` to reset conversation history and `/exit` to quit.

## Configuration

- `OPENAI_BASE_URL`: server base URL, default `http://127.0.0.1:9931` (without `/v1`)
- `OPENAI_MODEL`: model name, default `local-model`
- `OPENAI_API_KEY`: optional Bearer token
- `SYSTEM_PROMPT`: system message

The client sends `POST {OPENAI_BASE_URL}/v1/chat/completions`.
