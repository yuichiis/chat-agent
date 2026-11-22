import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };
type ToolEntry = { name: string; description?: string; inputSchema: Record<string, unknown> };
const clients = new Map<string, { client: Client; tools: ToolEntry[] }>();
const toolRoutes = new Map<string, { server: string; name: string }>();

export type OpenAITool = { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } };

export async function startMcpServers(configPath = resolve(process.cwd(), "config/mcp.json")): Promise<OpenAITool[]> {
  let parsed: { mcpServers?: Record<string, ServerConfig> };
  try { parsed = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      console.log(`MCP設定が見つからないため、MCPサーバーなしで起動します: ${configPath}`);
      return [];
    }
    throw new Error(`MCP設定を読み込めません (${configPath}): ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [serverName, config] of Object.entries(parsed.mcpServers ?? {})) {
    if (!config.command) throw new Error(`MCPサーバー ${serverName} にcommandがありません。`);
    const client = new Client({ name: "openai-compatible-chat-agent", version: "0.1.0" });
    const env = { ...process.env, ...config.env } as Record<string, string>;
    const transport = new StdioClientTransport({ command: config.command, args: config.args ?? [], env });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      clients.set(serverName, { client, tools: tools as ToolEntry[] });
      for (const tool of tools) toolRoutes.set(`${serverName}__${tool.name}`, { server: serverName, name: tool.name });
      console.log(`MCP接続: ${serverName} (${tools.length} tools)`);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`MCPサーバー ${serverName} に接続できません: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...clients.entries()].flatMap(([serverName, { tools }]) => tools.map((tool) => ({
    type: "function" as const,
    function: { name: `${serverName}__${tool.name}`, ...(tool.description ? { description: tool.description } : {}), parameters: tool.inputSchema },
  })));
}

export async function callMcpTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const route = toolRoutes.get(name);
  if (!route) throw new Error(`未登録のMCPツールです: ${name}`);
  const entry = clients.get(route.server);
  if (!entry) throw new Error(`MCPサーバーに接続されていません: ${route.server}`);
  return entry.client.callTool(
    { name: route.name, arguments: (args ?? {}) as Record<string, unknown> },
    undefined,
    signal ? { signal } : undefined,
  );
}

export async function stopMcpServers(): Promise<void> {
  await Promise.all([...clients.values()].map(({ client }) => client.close().catch(() => undefined)));
  clients.clear();
  toolRoutes.clear();
}
