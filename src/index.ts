import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadSystemPrompt, openAISettings, streamOpenAI, type ChatMessage } from "./openai.js";
import { runMatrixService } from "./matrix-service.js";
import { callMcpTool, startMcpServers, stopMcpServers } from "./mcp.js";

const cyan = (s: string) => `\u001b[36m${s}\u001b[0m`;
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;

async function runTui() {
  const mcpTools = await startMcpServers();
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  const history: ChatMessage[] = [];
  const systemPrompt = await loadSystemPrompt();
  history.push({ role: "system", content: systemPrompt });
  stdout.write(`${cyan("OpenAI-compatible TUI Chat")} ${dim(`${openAISettings.baseUrl} · ${openAISettings.model}`)}\n`);
  stdout.write(`${dim("/clear 履歴消去 · /exit 終了") }\n\n`);
  while (true) {
    let input: string;
    try { input = (await rl.question(cyan("you › "))).trim(); }
    catch { break; }
    if (!input) continue;
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") { history.splice(1); stdout.write(dim("履歴を消去しました。\n")); continue; }
    if (input.startsWith("/")) { stdout.write(dim("コマンド: /clear, /exit\n")); continue; }
    history.push({ role: "user", content: input });
    stdout.write(cyan("assistant › "));
    let reasoningLabelShown = false;
    try { history.push({ role: "assistant", content: await streamOpenAI(
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
    ) }); }
    catch (error) {
      history.pop();
      stdout.write(`\u001b[31m接続エラー: ${error instanceof Error ? error.message : String(error)}\u001b[0m\n`);
    }
    stdout.write("\n");
  }
  rl.close();
  await stopMcpServers();
  stdout.write(dim("終了しました。\n"));
}

const mode = process.argv[2] ?? "tui";
if (mode === "service") await runMatrixService({ debug: process.argv.includes("--debug") });
else if (mode === "tui") await runTui();
else { console.error("使い方: npm start -- [tui|service] [--debug]"); process.exitCode = 2; }
