import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import type { OpenAITool } from "./mcp.js";

export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
export type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
export type ToolCallEvent = { phase: "start" | "result" | "error"; name: string; args: unknown; detail?: string };
const baseUrl = (process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:9931").replace(/\/+$/, "");
const endpoint = `${baseUrl}/v1/chat/completions`;
let model = process.env.OPENAI_MODEL ?? "local-model";
const apiKey = process.env.OPENAI_API_KEY;
const defaultSystemPrompt = "You are a helpful assistant.";
const configuredStartupWaitSeconds = Number(process.env.OPENAI_STARTUP_WAIT_SECONDS ?? 120);
const startupWaitSeconds = Number.isInteger(configuredStartupWaitSeconds) && configuredStartupWaitSeconds >= 0
  ? configuredStartupWaitSeconds
  : 120;
if (startupWaitSeconds !== configuredStartupWaitSeconds) {
  console.warn("OPENAI_STARTUP_WAIT_SECONDS は0以上の整数で指定してください。120秒を使います。");
}
const configuredMaxToolRounds = Number(process.env.MCP_MAX_TOOL_ROUNDS ?? 8);
const maxToolRounds = Number.isInteger(configuredMaxToolRounds) && configuredMaxToolRounds >= 1
  ? configuredMaxToolRounds
  : 8;
if (maxToolRounds !== configuredMaxToolRounds) {
  console.warn("MCP_MAX_TOOL_ROUNDS は1以上の整数で指定してください。8回を使います。");
}

export async function loadSystemPrompt(): Promise<string> {
  if (process.env.SYSTEM_PROMPT !== undefined) return process.env.SYSTEM_PROMPT;
  const promptFile = process.env.SYSTEM_PROMPT_FILE;
  if (promptFile) {
    try {
      return await readFile(resolve(process.cwd(), promptFile), "utf8");
    } catch (error) {
      throw new Error(`SYSTEM_PROMPT_FILE を読み込めません (${promptFile}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return defaultSystemPrompt;
}

export async function listOpenAIModels(
  onServerStarting: (waitSeconds: number) => void | Promise<void> = (waitSeconds) => {
    stdout.write(`\nLLMサーバーを起動しています。${waitSeconds}秒待って再試行します…\n`);
  },
): Promise<string[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const request = () => fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(30_000) });
  let response = await request();
  if (response.status === 503) {
    const errorBody = await response.text();
    let noUpstreamsAvailable = false;
    try { noUpstreamsAvailable = (JSON.parse(errorBody) as { error?: unknown }).error === "no upstreams available"; }
    catch { /* return the original server error below */ }
    if (noUpstreamsAvailable) {
      await onServerStarting(startupWaitSeconds);
      await new Promise((resolveWait) => setTimeout(resolveWait, startupWaitSeconds * 1000));
      response = await request();
    } else {
      throw new Error(`HTTP 503: ${errorBody}`);
    }
  }
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
  onToken: (text: string) => void | Promise<void> = (text) => { stdout.write(text); },
  onServerStarting: (waitSeconds: number) => void | Promise<void> = (waitSeconds) => { stdout.write(`\nLLMサーバーを起動しています。${waitSeconds}秒待って再試行します…\n`); },
  onUsage: (usage: ChatUsage) => void = () => undefined,
  onReasoning: (text: string) => void | Promise<void> = () => undefined,
  tools: OpenAITool[] = [],
  executeTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown> = async () => { throw new Error("MCP tool executor is not configured."); },
  onToolCall: (event: ToolCallEvent) => void | Promise<void> = () => undefined,
  signal?: AbortSignal,
): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  let activeController = new AbortController();
  const request = async () => {
    if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
    activeController = new AbortController();
    const controller = activeController;
    const headerTimer = setTimeout(() => controller.abort(), 600_000);
    try {
      return await fetch(endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ model, messages, stream: true, stream_options: { include_usage: true }, ...(tools.length ? { tools, tool_choice: "auto" } : {}) }),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
      if (controller.signal.aborted) throw new Error("LLM APIから10分以内に応答ヘッダーを受信できませんでした。");
      throw error;
    } finally {
      clearTimeout(headerTimer);
    }
  };
  let retries = 0;
  while (true) {
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
      if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
      await new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolveWait();
        }, startupWaitSeconds * 1000);
        const onAbort = () => {
          clearTimeout(timer);
          rejectWait(new Error("LLM生成を中止しました (/stop)。"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
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
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  while (!finished) {
    let idleTimer: NodeJS.Timeout | undefined;
    let part: ReadableStreamReadResult<Uint8Array>;
    try {
      part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          idleTimer = setTimeout(() => {
            activeController.abort();
            reject(new Error("LLMストリームから10分間データを受信できませんでした。"));
          }, 600_000);
        }),
      ]);
    } catch (error) {
      if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
      throw error;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
    pending += decoder.decode(part.value, { stream: !part.done });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") { finished = true; break; }
      if (!data) continue;
      const chunk = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
        usage?: ChatUsage | null;
      };
      if (chunk.usage) onUsage(chunk.usage);
      const delta = chunk.choices?.[0]?.delta;
      for (const call of delta?.tool_calls ?? []) {
        const current = calls.get(call.index) ?? { id: "", name: "", arguments: "" };
        if (call.id) current.id += call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
      if (delta?.reasoning_content) await onReasoning(delta.reasoning_content);
      if (delta?.content) {
        answer += delta.content;
        await onToken(delta.content);
      }
    }
    if (part.done) break;
  }
  if (calls.size) {
    if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
    if (!tools.length) throw new Error("LLMがtool_callを返しましたが、利用可能なMCPツールがありません。");
    if (retries >= maxToolRounds) {
      throw new Error(`MCP tool-callの最大反復回数(${maxToolRounds}回)に達しました。MCP_MAX_TOOL_ROUNDSで変更できます。`);
    }
    retries++;
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
      id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments },
    }));
    messages.push({ role: "assistant", content: answer, tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args: unknown;
      try { args = JSON.parse(call.function.arguments || "{}"); }
      catch (error) {
        const detail = `ツール引数のJSONを解析できません (${call.function.name}): ${error instanceof Error ? error.message : String(error)}`;
        await onToolCall({ phase: "error", name: call.function.name, args: call.function.arguments, detail });
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: detail }) });
        continue;
      }
      await onToolCall({ phase: "start", name: call.function.name, args });
      if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
      let result: unknown;
      try {
        result = await executeTool(call.function.name, args, signal);
        const resultRecord = result && typeof result === "object" ? result as { isError?: unknown; content?: unknown } : undefined;
        if (resultRecord?.isError === true) {
          const detail = JSON.stringify(resultRecord.content ?? result);
          await onToolCall({ phase: "error", name: call.function.name, args, detail });
        } else {
          await onToolCall({ phase: "result", name: call.function.name, args, detail: JSON.stringify(result) });
        }
      } catch (error) {
        if (signal?.aborted) throw new Error("LLM生成を中止しました (/stop)。");
        const detail = error instanceof Error ? error.message : String(error);
        result = { error: detail };
        await onToolCall({ phase: "error", name: call.function.name, args, detail });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
    continue;
  }
  return answer;
  }
}

export const openAISettings = { baseUrl, get model() { return model; }, startupWaitSeconds };
