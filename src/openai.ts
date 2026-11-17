import { stdout } from "node:process";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:9931").replace(/\/+$/, "");
const endpoint = `${baseUrl}/v1/chat/completions`;
const model = process.env.OPENAI_MODEL ?? "local-model";
const apiKey = process.env.OPENAI_API_KEY;

export async function streamOpenAI(messages: ChatMessage[], onToken: (text: string) => void = (text) => stdout.write(text)): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages, stream: true }),
    signal: AbortSignal.timeout(600_000),
  });
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
      const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) { answer += text; onToken(text); }
    }
    if (part.done) break;
  }
  return answer;
}

export const openAISettings = { baseUrl, model };
