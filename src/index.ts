import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { listOpenAIModels, loadSystemPrompt, openAISettings, setOpenAIModel, streamOpenAI, type ChatMessage } from "./openai.js";
import { runMatrixService } from "./matrix-service.js";
import { callMcpTool, startMcpServers, stopMcpServers } from "./mcp.js";

const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;

async function runTui(options: { debug?: boolean } = {}) {
  const mcpTools = await startMcpServers();
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const history: ChatMessage[] = [];
  const systemPrompt = await loadSystemPrompt();
  history.push({ role: "system", content: systemPrompt });
  const queuedLines: string[] = [];
  let inputResolver: ((line: string | null) => void) | undefined;
  let inputClosed = false;
  let activeRequest: AbortController | undefined;
  const enqueueLine = (line: string) => {
    if (inputResolver) {
      const resolveLine = inputResolver;
      inputResolver = undefined;
      resolveLine(line);
    } else queuedLines.push(line);
  };
  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === "/stop" && activeRequest) {
      activeRequest.abort();
      stdout.write(`\n${dim("生成を中止しています...")}\n`);
      return;
    }
    enqueueLine(line);
  });
  rl.on("close", () => {
    inputClosed = true;
    activeRequest?.abort();
    inputResolver?.(null);
    inputResolver = undefined;
  });
  const nextLine = (): Promise<string | null> => {
    const queued = queuedLines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (inputClosed) return Promise.resolve(null);
    return new Promise((resolveLine) => { inputResolver = resolveLine; });
  };
  stdout.write(`${cyan("OpenAI-compatible TUI Chat")} ${dim(`${openAISettings.baseUrl} · ${openAISettings.model}`)}\n`);
  stdout.write(`${dim("/new 履歴消去 · /model モデル一覧・切り替え · /stop 生成中止 · /exit 終了")}\n\n`);
  try {
    while (true) {
      stdout.write(cyan("you › "));
      const line = await nextLine();
      if (line === null) break;
      const input = line.trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input.toLowerCase() === "/new") { history.splice(1); stdout.write(dim("会話履歴をリセットしました。\n")); continue; }
      if (input.toLowerCase() === "/stop") { stdout.write(dim("実行中の生成はありません。\n")); continue; }
      if (/^\/model(?:\s|$)/iu.test(input)) {
        const argument = input.slice("/model".length).trim();
        if (!argument) {
          try {
            const models = await listOpenAIModels();
            stdout.write(models.length
              ? `利用可能なモデル:\n${models.map((id) => `${id}${id === openAISettings.model ? "（選択中）" : ""}`).join("\n")}\n`
              : "Models APIからモデルが見つかりませんでした。\n");
          } catch (error) {
            stdout.write(`\u001b[31mモデル一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}\u001b[0m\n`);
          }
        } else if (/\s/u.test(argument)) stdout.write(dim("使い方: /model または /model <model-id>\n"));
        else {
          setOpenAIModel(argument);
          stdout.write(dim(`モデルを ${openAISettings.model} に切り替えました。\n`));
        }
        continue;
      }
      if (input.startsWith("/")) { stdout.write(dim("コマンド: /new, /model [model-id], /stop, /exit\n")); continue; }
      const historyStartLength = history.length;
      history.push({ role: "user", content: input });
      const controller = new AbortController();
      activeRequest = controller;
      stdout.write(`${cyan("assistant › ")}${dim("(生成中、/stopで中止できます)\n")}${cyan("生成中の入力 › ")}`);
      let reasoningLabelShown = false;
      try {
        const answer = await streamOpenAI(
          history,
          (text) => { stdout.write(text); },
          undefined,
          undefined,
          (text) => {
            if (!reasoningLabelShown) { stdout.write(`\n${dim("[reasoning] ")}`); reasoningLabelShown = true; }
            stdout.write(text);
          },
          mcpTools,
          callMcpTool,
          (event) => {
            const label = event.phase === "start" ? "実行中" : event.phase === "result" ? "結果" : "エラー";
            stdout.write(`\n${dim(`[tool ${label}] ${event.name}${event.detail ? `: ${event.detail}` : ` ${JSON.stringify(event.args)}`}`)}\n`);
          },
          controller.signal,
          options.debug ? (message) => { stdout.write(`\n${dim(message)}\n`); } : undefined,
        );
        history.push({ role: "assistant", content: answer });
      } catch (error) {
        history.splice(historyStartLength);
        if (controller.signal.aborted) stdout.write(dim("生成を中止しました。\n"));
        else stdout.write(`\u001b[31m接続エラー: ${error instanceof Error ? error.message : String(error)}\u001b[0m\n`);
      } finally {
        if (activeRequest === controller) activeRequest = undefined;
      }
      stdout.write("\n");
    }
  } finally {
    rl.close();
    await stopMcpServers();
  }
  stdout.write(dim("終了しました。\n"));
}

const mode = process.argv[2] ?? "tui";
if (mode === "service") await runMatrixService({ debug: process.argv.includes("--debug") });
else if (mode === "tui") await runTui({ debug: process.argv.includes("--debug") });
else { console.error("使い方: npm start -- [tui|service] [--debug]"); process.exitCode = 2; }
