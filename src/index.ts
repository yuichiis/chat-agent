import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

type Message = { role: "system" | "user" | "assistant"; content: string };
type Chunk = { choices?: Array<{ delta?: { content?: string } }> };
const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:9931").replace(/\/+$/, "");
const endpoint = `${baseUrl}/v1/chat/completions`;
const model = process.env.OPENAI_MODEL ?? "local-model";
const apiKey = process.env.OPENAI_API_KEY;
const systemPrompt = process.env.SYSTEM_PROMPT ?? "You are a helpful assistant.";
const history: Message[] = [];
const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;

async function chat(): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint, {
    method: "POST", headers,
    body: JSON.stringify({ model, messages: [{ role: "system", content: systemPrompt }, ...history], stream: true }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  if (!response.body) throw new Error("レスポンス本文がありません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "", answer = "", done = false;
  while (!done) {
    const part = await reader.read();
    pending += decoder.decode(part.value, { stream: !part.done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { done = true; break; }
      if (!data) continue;
      const chunk = JSON.parse(data) as Chunk;
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) { stdout.write(text); answer += text; }
    }
    if (part.done) break;
  }
  stdout.write("\n");
  return answer;
}

async function main() {
  stdout.write(`${cyan("OpenAI-compatible TUI Chat")} ${dim(`${baseUrl} · ${model}`)}\n`);
  stdout.write(`${dim("/clear 履歴消去 · /exit 終了") }\n\n`);
  while (true) {
    let input: string;
    try { input = (await rl.question(cyan("you › "))).trim(); }
    catch { break; }
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") { history.length = 0; stdout.write(dim("履歴を消去しました。\n")); continue; }
    if (input.startsWith("/")) { stdout.write(dim("コマンド: /clear, /exit\n")); continue; }
    history.push({ role: "user", content: input });
    stdout.write(cyan("assistant › "));
    try { history.push({ role: "assistant", content: await chat() }); }
    catch (error) {
      history.pop();
      stdout.write(`\u001b[31m接続エラー: ${error instanceof Error ? error.message : String(error)}\u001b[0m\n`);
      stdout.write(dim(`接続先: ${endpoint}\n`));
    }
    stdout.write("\n");
  }
  rl.close();
  stdout.write(dim("終了しました。\n"));
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
