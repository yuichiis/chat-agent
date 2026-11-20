import { stdout } from "node:process";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:9931").replace(/\/+$/, "");
const endpoint = `${baseUrl}/v1/chat/completions`;
let model = process.env.OPENAI_MODEL ?? "local-model";
const apiKey = process.env.OPENAI_API_KEY;
const configuredStartupWaitSeconds = Number(process.env.OPENAI_STARTUP_WAIT_SECONDS ?? 120);
const startupWaitSeconds = Number.isInteger(configuredStartupWaitSeconds) && configuredStartupWaitSeconds >= 0
  ? configuredStartupWaitSeconds
  : 120;
if (startupWaitSeconds !== configuredStartupWaitSeconds) {
  console.warn("OPENAI_STARTUP_WAIT_SECONDS は0以上の整数で指定してください。120秒を使います。");
}

export async function listOpenAIModels(): Promise<string[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(payload.data)) throw new Error("models APIの応答にdata配列がありません。");
  return payload.data.flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
}

export function setOpenAIModel(modelId: string): void {
  const selected = modelId.trim();
  if (!selected) throw new Error("モデルIDを指定してください。");
  model = selected;
}

export async function streamOpenAI(
  messages: ChatMessage[],
  onToken: (text: string) => void = (text) => stdout.write(text),
  onServerStarting: (waitSeconds: number) => void | Promise<void> = (waitSeconds) => { stdout.write(`\nLLMサーバーを起動しています。${waitSeconds}秒待って再試行します…\n`); },
  onUsage: (usage: ChatUsage) => void = () => undefined,
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const request = () => fetch(endpoint, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(600_000),
  });
  let response = await request();
  if (response.status === 503) {
    const errorBody = await response.text();
    let noUpstreamsAvailable = false;
    try {
      const payload = JSON.parse(errorBody) as { error?: unknown };
      noUpstreamsAvailable = payload.error === "no upstreams available";
    } catch { /* keep the server's original error below */ }
    if (noUpstreamsAvailable) {
      await onServerStarting(startupWaitSeconds);
      await new Promise((resolveWait) => setTimeout(resolveWait, startupWaitSeconds * 1000));
      response = await request();
    } else {
      throw new Error(`OpenAI API HTTP 503: ${errorBody}`);
    }
  }
  if (!response.ok) throw new Error(`OpenAI API HTTP ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("レスポンス本文がありません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", answer = "", finished = false;
  while (!finished) {
    const part = await reader.read();
    pending += decoder.decode(part.value, { stream: !part.done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { finished = true; break; }
      if (!data) continue;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: ChatUsage | null;
      };
      if (chunk.usage) onUsage(chunk.usage);
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) { answer += text; onToken(text); }
    }
    if (part.done) break;
  }
  return answer;
}

export const openAISettings = { baseUrl, get model() { return model; }, startupWaitSeconds };
