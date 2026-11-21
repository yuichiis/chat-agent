import "fake-indexeddb/auto";
import { deserialize, serialize } from "node:v8";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ClientEvent, EventType, MatrixEventEvent, MsgType, OAuth2, RoomEvent, SyncState, createClient } from "matrix-js-sdk";
import { VerificationPhase, VerificationRequestEvent, VerifierEvent } from "../node_modules/matrix-js-sdk/lib/crypto-api/verification.js";
import type { ShowSasCallbacks } from "../node_modules/matrix-js-sdk/lib/crypto-api/verification.js";
import type { Logger } from "../node_modules/matrix-js-sdk/lib/logger.js";
import { logger as matrixGlobalLogger } from "../node_modules/matrix-js-sdk/lib/logger.js";
import { RelationType } from "../node_modules/matrix-js-sdk/lib/@types/event.js";
import type { ChatMessage, ChatUsage } from "./openai.js";
import { listOpenAIModels, loadSystemPrompt, openAISettings, setOpenAIModel, streamOpenAI } from "./openai.js";
import { callMcpTool, startMcpServers, stopMcpServers, type OpenAITool } from "./mcp.js";

const homeserver = (process.env.MATRIX_HOMESERVER_URL ?? "https://matrix.org").replace(/\/+$/, "");
const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../data");
const clientInfoPath = resolve(dataDir, "matrix-client.json");
const sessionPath = resolve(dataDir, "matrix-session.json");
type ClientInfo = { clientId: string };
type MatrixSession = {
  clientId: string;
  deviceId: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
};
type StoreSnapshot = { name: string; keyPath: IDBObjectStoreParameters["keyPath"]; autoIncrement: boolean; indexes: Array<{ name: string; keyPath: string | string[]; multiEntry: boolean; unique: boolean }>; records: Array<{ key: IDBValidKey; value: unknown }> };
type DatabaseSnapshot = { name: string; version: number; stores: StoreSnapshot[] };

function containsUserIdMention(text: string, userId: string): boolean {
  let offset = text.indexOf(userId);
  while (offset >= 0) {
    const before = offset === 0 || /[\s([<{]/u.test(text[offset - 1] ?? "");
    const afterIndex = offset + userId.length;
    const after = afterIndex === text.length || /[\s.,!?;:)\]}>]/u.test(text[afterIndex] ?? "");
    if (before && after) return true;
    offset = text.indexOf(userId, offset + userId.length);
  }
  return false;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolveRequest, rejectRequest) => {
    request.addEventListener("success", () => resolveRequest(request.result), { once: true });
    request.addEventListener("error", () => rejectRequest(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolveTransaction, rejectTransaction) => {
    transaction.addEventListener("complete", () => resolveTransaction(), { once: true });
    transaction.addEventListener("abort", () => rejectTransaction(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => rejectTransaction(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

async function dumpCryptoDatabases(prefix: string): Promise<DatabaseSnapshot[]> {
  const databases = await indexedDB.databases();
  const snapshots: DatabaseSnapshot[] = [];
  for (const info of databases) {
    if (!info.name?.startsWith(`${prefix}::`) || !info.version) continue;
    const db = await requestResult(indexedDB.open(info.name, info.version));
    try {
      const stores: StoreSnapshot[] = [];
      for (const storeName of db.objectStoreNames) {
        const transaction = db.transaction(storeName, "readonly");
        const finished = transactionComplete(transaction);
        const store = transaction.objectStore(storeName);
        const indexes = Array.from(store.indexNames, (name) => {
          const index = store.index(name);
          return { name, keyPath: index.keyPath, multiEntry: index.multiEntry, unique: index.unique };
        });
        const [keys, values] = await Promise.all([requestResult(store.getAllKeys()), requestResult(store.getAll())]);
        await finished;
        stores.push({ name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes, records: keys.map((key, i) => ({ key, value: values[i] })) });
      }
      snapshots.push({ name: info.name, version: info.version, stores });
    } finally {
      db.close();
    }
  }
  return snapshots;
}

async function restoreCryptoDatabases(prefix: string, snapshotPath: string): Promise<boolean> {
  let bytes: Buffer;
  try { bytes = await readFile(snapshotPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const snapshots = deserialize(bytes) as DatabaseSnapshot[];
  if (!Array.isArray(snapshots) || snapshots.length === 0 || snapshots.some((db) => !db.name.startsWith(`${prefix}::`) || !Number.isInteger(db.version) || !Array.isArray(db.stores))) {
    throw new Error(`暗号鍵ストアの保存データが不正です: ${snapshotPath}`);
  }
  for (const snapshot of snapshots) {
    const request = indexedDB.open(snapshot.name, snapshot.version);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      for (const storeSnapshot of snapshot.stores) {
        const options: IDBObjectStoreParameters = { autoIncrement: storeSnapshot.autoIncrement };
        if (storeSnapshot.keyPath !== null) options.keyPath = storeSnapshot.keyPath;
        const store = db.createObjectStore(storeSnapshot.name, options);
        for (const index of storeSnapshot.indexes) store.createIndex(index.name, index.keyPath, { multiEntry: index.multiEntry, unique: index.unique });
      }
    });
    const db = await requestResult(request);
    try {
      for (const storeSnapshot of snapshot.stores) {
        const transaction = db.transaction(storeSnapshot.name, "readwrite");
        const finished = transactionComplete(transaction);
        const store = transaction.objectStore(storeSnapshot.name);
        for (const record of storeSnapshot.records) {
          if (storeSnapshot.keyPath === null) store.put(record.value, record.key);
          else store.put(record.value);
        }
        await finished;
      }
    } finally {
      db.close();
    }
  }
  return true;
}

async function saveCryptoDatabases(prefix: string, snapshotPath: string): Promise<void> {
  const snapshots = await dumpCryptoDatabases(prefix);
  if (snapshots.length === 0) return;
  await mkdir(dirname(snapshotPath), { recursive: true });
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, serialize(snapshots), { mode: 0o600 });
  await rename(temporaryPath, snapshotPath);
}

async function saveSession(session: MatrixSession): Promise<void> {
  await mkdir(dirname(sessionPath), { recursive: true });
  const temporaryPath = `${sessionPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, sessionPath);
}

async function loadSession(): Promise<MatrixSession | null> {
  let text: string;
  try { text = await readFile(sessionPath, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const value = JSON.parse(text) as Partial<MatrixSession>;
  if (![value.clientId, value.deviceId, value.userId, value.accessToken, value.refreshToken].every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error(`Matrix セッションファイルの内容が不正です: ${sessionPath}`);
  }
  return value as MatrixSession;
}

async function getOAuthClientId(metadata: Awaited<ReturnType<ReturnType<typeof createClient>["getAuthMetadata"]>>): Promise<string> {
  if (process.env.MATRIX_OAUTH_CLIENT_ID) return process.env.MATRIX_OAUTH_CLIENT_ID;
  try {
    const saved = JSON.parse(await readFile(clientInfoPath, "utf8")) as ClientInfo;
    if (saved.clientId) return saved.clientId;
  } catch { /* register a client on first run */ }
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      application_type: "native",
      client_name: "OpenAI Matrix Chat Agent",
      client_uri: "https://matrix.org/",
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) throw new Error(`Matrix OAuth クライアント登録に失敗しました (HTTP ${response.status}): ${await response.text()}`);
  const registration = await response.json() as { client_id?: string };
  if (!registration.client_id) throw new Error("Matrix OAuth 登録応答に client_id がありません。");
  const clientId = registration.client_id;
  await mkdir(dirname(clientInfoPath), { recursive: true });
  await writeFile(clientInfoPath, `${JSON.stringify({ clientId }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return clientId;
}

function createSdkLogger(debug: boolean, namespace = "Matrix"): Logger {
  const shortText = (args: unknown[]) => args.map((value) => value instanceof Error ? value.message : typeof value === "string" ? value : (() => {
    if (value && typeof value === "object") {
      const item = value as { message?: unknown; error?: unknown; errcode?: unknown };
      if (typeof item.message === "string") return item.message;
      if (typeof item.error === "string") return item.error;
      if (typeof item.errcode === "string") return item.errcode;
    }
    return String(value);
  })()).join(" ").slice(0, 500);
  const emit = (level: "trace" | "debug" | "info" | "warn" | "error", args: unknown[]) => {
    if (debug) console[level](`[${namespace}]`, ...args);
    else if (level === "warn" || level === "error") console[level](`[${namespace}] ${shortText(args)}`);
  };
  return {
    trace: (...args) => emit("trace", args),
    debug: (...args) => emit("debug", args),
    info: (...args) => emit("info", args),
    warn: (...args) => emit("warn", args),
    error: (...args) => emit("error", args),
    getChild: (child) => createSdkLogger(debug, `${namespace}/${child}`),
  };
}

function filterSdkConsole(debug: boolean): void {
  if (debug) return;
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const stderr = process.stderr as unknown as { write: (chunk: unknown, ...args: unknown[]) => boolean };
  const originalStderrWrite = stderr.write.bind(process.stderr);
  const noisy = /^(?:FetchHttpApi:|OAuth2:|DEBUG matrix_sdk_|INFO matrix_sdk_|WARN matrix_sdk_|\[Matrix\] (?:WARN )?matrix_sdk_|\[Perf\]:|sync |Attempting to |Checking capabilites|Checking capabilities|PollingCachedValue|Missing default global|Adding default global|\[RustBackupManager\]|\[PerSessionKeyBackupDownloader\]|\[MatrixRTCSession )/;
  console.debug = () => undefined;
  console.info = () => undefined;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && noisy.test(args[0])) return;
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === "string" && (noisy.test(args[0]) || args[0].startsWith("[Matrix] Missing default global") || args[0].startsWith("[Matrix] Adding default global"))) return;
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && (/^Error decrypting event \(/.test(args[0]) || noisy.test(args[0]))) return;
    originalError(...args);
  };
  stderr.write = (chunk: unknown, ...args: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
    if (/Error decrypting event \(/.test(text)) return true;
    return originalStderrWrite(chunk, ...args);
  };
}

async function login(sdkLogger: Logger) {
  const discoveryClient = createClient({ baseUrl: homeserver, logger: sdkLogger });
  const metadata = await discoveryClient.getAuthMetadata();
  if (!metadata.device_authorization_endpoint) {
    throw new Error("このホームサーバーは OAuth デバイス認証に対応していません。");
  }
  const saved = await loadSession();
  if (saved) {
    const savedCryptoPath = resolve(dataDir, `matrix-crypto-${saved.deviceId}.bin`);
    let cryptoStateExists = true;
    try { await access(savedCryptoPath, constants.F_OK); }
    catch { cryptoStateExists = false; }
    if (cryptoStateExists) {
      try {
        const oauth = new OAuth2(metadata, { clientId: saved.clientId, deviceId: saved.deviceId });
        const refreshed = await oauth.performRefreshTokenGrant(saved.refreshToken);
        const identity = await createClient({ baseUrl: homeserver, accessToken: refreshed.access_token, deviceId: saved.deviceId, logger: sdkLogger }).whoami();
        if (identity.user_id !== saved.userId) throw new Error("更新後の Matrix セッションが保存済みアカウントと一致しません。");
        const session: MatrixSession = {
          ...saved,
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? saved.refreshToken,
          expiresAt: refreshed.expires_in ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString() : undefined,
        };
        await saveSession(session);
        console.log(`保存済み Matrix セッションを再利用します: ${session.userId}`);
        return session;
      } catch (error) {
        console.warn(`保存済み Matrix セッションを更新できないため、再認証します: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.warn("保存済みセッションに対応する暗号鍵ストアがありません。安全のため新しいデバイスとして認証します。");
    }
  }
  const clientId = await getOAuthClientId(metadata);
  const oauth = new OAuth2(metadata, { clientId });
  const deviceSession = await oauth.startDeviceAuthorizationGrant();
  console.log(`\nMatrix 認証を行ってください: ${deviceSession.verification_uri_complete ?? deviceSession.verification_uri}`);
  if (!deviceSession.verification_uri_complete) console.log(`認証コード: ${deviceSession.user_code}`);
  console.log("ブラウザで承認されるまで待機します…");
  const result = await oauth.waitForDeviceAuthorizationGrant(deviceSession);
  if (!("access_token" in result)) throw new Error(`OAuth 認証に失敗しました: ${result.error}`);

  const client = createClient({ baseUrl: homeserver, accessToken: result.access_token, deviceId: oauth.context.deviceId, logger: sdkLogger });
  const identity = await client.whoami();
  if (!result.refresh_token) throw new Error("Matrix OAuth サーバーから refresh token が返されませんでした。");
  const session: MatrixSession = {
    clientId,
    deviceId: oauth.context.deviceId,
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    userId: identity.user_id,
    expiresAt: result.expires_in ? new Date(Date.now() + result.expires_in * 1000).toISOString() : undefined,
  };
  await saveSession(session);
  return session;
}

export async function runMatrixService(options: { debug?: boolean } = {}): Promise<void> {
  const debug = options.debug ?? false;
  const serviceStartedAt = Date.now();
  const systemPrompt = await loadSystemPrompt();
  let mcpTools: OpenAITool[] = [];
  try { mcpTools = await startMcpServers(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); throw error; }
  filterSdkConsole(debug);
  (matrixGlobalLogger as unknown as { setLevel(level: string): void }).setLevel(debug ? "debug" : "warn");
  const sdkLogger = createSdkLogger(debug);
  console.log(`Matrix サービスを開始します (${homeserver})`);
  console.log(`LLM: ${openAISettings.baseUrl} · ${openAISettings.model}`);
  console.log(`オンデマンド起動待ち: ${openAISettings.startupWaitSeconds}秒`);
  console.log("応答条件: 参加中メンバー2人以下は他の人の投稿、3人以上はエージェントへのメンション");
  console.log("Matrixコマンド: /new, /status, /model [model-id]");
  console.log(debug ? "デバッグログ: 有効" : "デバッグログ: 無効（--debug で有効）");
  console.log("起動後のコマンド: /verify（この端末を認証）, /help。終了: Ctrl+C");

  const session = await login(sdkLogger);
  const cryptoPrefix = `openai-matrix-${session.deviceId}`;
  const cryptoSnapshotPath = resolve(dataDir, `matrix-crypto-${session.deviceId}.bin`);
  const restoredCrypto = await restoreCryptoDatabases(cryptoPrefix, cryptoSnapshotPath);
  console.log(restoredCrypto ? "保存済みの暗号化デバイス鍵を復元しました。" : "暗号化デバイス鍵ストアを新規作成します。");

  let sessionToPersist = session;
  let tokenWriteQueue = Promise.resolve();
  const client = createClient({
    baseUrl: homeserver,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    oauthClientId: session.clientId,
    logger: sdkLogger,
    onTokenRefresh: (tokens) => {
      sessionToPersist = {
        ...sessionToPersist,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? sessionToPersist.refreshToken,
        expiresAt: tokens.expiry?.toISOString(),
      };
      const latestSession = sessionToPersist;
      tokenWriteQueue = tokenWriteQueue.then(() => saveSession(latestSession)).catch((error: unknown) => {
        console.error("Matrix セッションの保存に失敗しました:", error);
      });
    },
  });
  await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: cryptoPrefix });
  console.log(`Agent Device ID: ${session.deviceId}`);

  let snapshotTask: Promise<void> | undefined;
  const persistCrypto = (): Promise<void> => {
    if (snapshotTask) return snapshotTask;
    snapshotTask = saveCryptoDatabases(cryptoPrefix, cryptoSnapshotPath)
      .catch((error: unknown) => { console.error("Matrix 暗号鍵ストアの保存に失敗しました:", error); })
      .finally(() => { snapshotTask = undefined; });
    return snapshotTask;
  };

  const conversations = new Map<string, ChatMessage[]>();
  const usageByRoom = new Map<string, ChatUsage>();
  const seen = new Set<string>();
  const decryptWarningAt = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const hasOwnEyesReaction = async (roomId: string, eventId: string): Promise<boolean> => {
    let from: string | undefined;
    do {
      const page = await client.relations(roomId, eventId, "m.annotation", EventType.Reaction, { from, limit: 100 });
      if (page.events.some((relation) => {
        if (relation.getSender() !== session.userId) return false;
        const relationContent = relation.getContent<{ "m.relates_to"?: { key?: string } }>();
        return relationContent["m.relates_to"]?.key === "👀";
      })) return true;
      if (!page.nextBatch || page.nextBatch === from) return false;
      from = page.nextBatch;
    } while (from);
    return false;
  };
  const handleMessage = (event: import("matrix-js-sdk").MatrixEvent, room: import("matrix-js-sdk").Room | undefined) => {
    if (event.getType() !== EventType.RoomMessage) return;
    if (event.getTs() <= serviceStartedAt) return;
    if (event.getSender() === session.userId) return;
    const content = event.getContent<{
      msgtype?: string;
      body?: string;
      formatted_body?: string;
      "m.mentions"?: { user_ids?: string[] };
    }>();
    if (content.msgtype !== "m.text" || !content.body || !room) return;
    const joinedMemberCount = room.getJoinedMemberCount();
    const mentionedViaMetadata = content["m.mentions"]?.user_ids?.includes(session.userId) ?? false;
    const mentionedInBody = containsUserIdMention(content.body, session.userId)
      || content.formatted_body?.includes(`matrix.to/#/${session.userId}`)
      || content.formatted_body?.includes(`matrix.to/#/${encodeURIComponent(session.userId)}`)
      || false;
    if (joinedMemberCount > 2 && !mentionedViaMetadata && !mentionedInBody) return;
    const eventId = event.getId();
    if (eventId && seen.has(eventId)) return;
    if (eventId) seen.add(eventId);
    const prompt = content.body.trim();
    if (!prompt) return;

    const prior = queues.get(room.roomId) ?? Promise.resolve();
    const task = prior.then(async () => {
      if (!eventId) {
        console.warn(`[${room.name || room.roomId}] event IDがないため処理をスキップしました。`);
        return;
      }
      if (await hasOwnEyesReaction(room.roomId, eventId)) {
        console.log(`[${room.name || room.roomId}] 既に👀リアクションがあるためスキップしました。`);
        return;
      }
      await client.sendEvent(room.roomId, EventType.Reaction, {
        "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key: "👀" },
      });
      console.log(`[${room.name || room.roomId}] 👀を付けて処理します。`);
      console.log(`[${room.name || room.roomId}] ${joinedMemberCount}人 · ${event.getSender()}: ${prompt}`);
      const commandInput = prompt.trimStart();
      if (commandInput.startsWith("/")) {
        const command = commandInput.split(/\s/u, 1)[0].toLowerCase();
        let commandReply: string;
        if (command === "/new") {
          conversations.set(room.roomId, [{ role: "system", content: systemPrompt }]);
          usageByRoom.delete(room.roomId);
          commandReply = "会話履歴をリセットしました。新しい会話を始めます。";
        } else if (command === "/status") {
          const messageCount = Math.max(0, (conversations.get(room.roomId)?.length ?? 1) - 1);
          const usage = usageByRoom.get(room.roomId);
          const usageLine = usage
            ? `直近のLLMリクエスト: prompt_tokens=${usage.prompt_tokens ?? "不明"}, completion_tokens=${usage.completion_tokens ?? "不明"}, total_tokens=${usage.total_tokens ?? "不明"}`
            : "LLMトークン使用量: まだ取得できていません。";
          commandReply = `モデル: ${openAISettings.model}\n${usageLine}\n会話履歴: ${messageCount}メッセージ（system promptを除く）\n最大コンテキスト長はLLM APIから取得できません。`;
        } else if (command === "/model") {
          const argument = commandInput.slice(command.length).trim();
          if (!argument) {
            try {
              const models = await listOpenAIModels();
              commandReply = models.length
                ? `利用可能なモデル:\n${models.map((id) => `${id}${id === openAISettings.model ? "（選択中）" : ""}`).join("\n")}`
                : "Models APIからモデルが見つかりませんでした。";
            } catch (error) {
              commandReply = `モデル一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else if (/\s/u.test(argument)) {
            commandReply = "使い方: /model または /model <model-id>";
          } else {
            setOpenAIModel(argument);
            commandReply = `モデルを ${openAISettings.model} に切り替えました。`;
          }
        } else {
          commandReply = `不明なコマンドです: ${command}\n利用可能なコマンド: /new, /status, /model`;
        }
        await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: commandReply });
        console.log(`  -> ${command}`);
        return;
      }
      let history = conversations.get(room.roomId);
      if (!history) { history = [{ role: "system", content: systemPrompt }]; conversations.set(room.roomId, history); }
      history.push({ role: "user", content: prompt });
      const typingTimeoutMs = 30_000;
      let typingStarted = false;
      let typingRefresh: NodeJS.Timeout | undefined;
      let progressEventId: string | undefined;
      let progressBody: string | undefined;
      let progressTimer: NodeJS.Timeout | undefined;
      let lastProgressUpdateAt = 0;
      let progressQueue = Promise.resolve();
      const writeProgress = async (body: string): Promise<void> => {
        const write = async () => {
          if (!progressEventId) {
            const sent = await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body });
            progressEventId = sent.event_id;
          } else {
            await client.sendMessage(room.roomId, {
              msgtype: MsgType.Text,
              body: `*${body}`,
              "m.new_content": { msgtype: MsgType.Text, body },
              "m.relates_to": { rel_type: RelationType.Replace, event_id: progressEventId },
            });
          }
          lastProgressUpdateAt = Date.now();
        };
        progressQueue = progressQueue.catch(() => undefined).then(write);
        await progressQueue;
      };
      const updateProgress = async (body: string, force = false): Promise<boolean> => {
        progressBody = body;
        const waitMs = 1_000 - (Date.now() - lastProgressUpdateAt);
        if (progressEventId && !force && waitMs > 0) {
          if (!progressTimer) {
            progressTimer = setTimeout(() => {
              progressTimer = undefined;
              const pending = progressBody;
              if (pending !== undefined) void updateProgress(pending, true);
            }, waitMs);
          }
          return true;
        }
        if (progressTimer) clearTimeout(progressTimer);
        progressTimer = undefined;
        progressBody = undefined;
        try {
          await writeProgress(body);
          return true;
        } catch (error) {
          console.warn(`[${room.name || room.roomId}] 進捗メッセージを更新できません: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      };
      let reasoningText = "";
      let streamedAnswer = "";
      let contentStarted = false;
      try {
        try {
          await client.sendTyping(room.roomId, true, typingTimeoutMs);
          typingStarted = true;
          typingRefresh = setInterval(() => {
            void client.sendTyping(room.roomId, true, typingTimeoutMs).catch((error: unknown) => {
              console.warn(`[${room.name || room.roomId}] 入力中表示の更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
            });
          }, 20_000);
        } catch (error) {
          console.warn(`[${room.name || room.roomId}] 入力中表示を開始できません: ${error instanceof Error ? error.message : String(error)}`);
        }
        const answer = await streamOpenAI(history, async (text) => {
          streamedAnswer += text;
          if (progressEventId) {
            contentStarted = true;
            await updateProgress(streamedAnswer.slice(-4_000));
          }
        }, async (waitSeconds) => {
          const startupNotice = `LLMサーバーを起動しています。約${waitSeconds}秒後に自動で再試行します。`;
          console.log(`[${room.name || room.roomId}] ${startupNotice}`);
          await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: startupNotice }).catch((error: unknown) => {
            console.warn(`[${room.name || room.roomId}] 起動待ちメッセージを送信できません: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, (usage) => { usageByRoom.set(room.roomId, usage); }, async (text) => {
          reasoningText += text;
          if (!progressEventId) await updateProgress("考え中...", true);
          else if (!contentStarted) await updateProgress(`考え中...\n${reasoningText.slice(-3_000)}`);
        }, mcpTools, callMcpTool, async (toolEvent) => {
          if (toolEvent.phase === "error") {
            const detail = toolEvent.detail || "詳細不明";
            const notice = `MCPツール ${toolEvent.name} でエラーが発生しました:\n${detail.slice(0, 2_000)}\n考え中...`;
            console.error(`[${room.name || room.roomId}] ${notice}`);
            await updateProgress(notice, true);
          } else if (toolEvent.phase === "start") {
            const args = JSON.stringify(toolEvent.args);
            const notice = `MCPツール実行中: ${toolEvent.name}\n引数: ${args.slice(0, 1_000)}`;
            console.log(`[${room.name || room.roomId}] ${notice}`);
            await updateProgress(notice, true);
          } else {
            const notice = `MCPツール完了: ${toolEvent.name}`;
            console.log(`[${room.name || room.roomId}] ${notice}`);
            await updateProgress(`${notice}\n考え中...`, true);
          }
        });
        if (!answer) throw new Error("LLMの応答に本文がありません。");
        if (progressEventId) {
          const updated = await updateProgress(answer, true);
          if (!updated) await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: answer });
        } else {
          await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: answer });
        }
        history.push({ role: "assistant", content: answer });
        console.log("  -> replied");
      } catch (error) {
        history.pop();
        const message = error instanceof Error ? error.message : String(error);
        console.error(`LLM/Matrix reply failed: ${message}`);
        const failureMessage = `処理中にエラーが発生しました。\n${message.slice(0, 2_000)}`;
        if (progressEventId) {
          const updated = await updateProgress(failureMessage, true);
          if (!updated) await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: failureMessage }).catch(console.error);
        } else {
          await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: failureMessage }).catch(console.error);
        }
      } finally {
        if (progressTimer) clearTimeout(progressTimer);
        if (typingRefresh) clearInterval(typingRefresh);
        if (typingStarted) {
          await client.sendTyping(room.roomId, false, typingTimeoutMs).catch((error: unknown) => {
            console.warn(`[${room.name || room.roomId}] 入力中表示の解除に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
    }).catch((error: unknown) => {
      console.error(`[${room.name || room.roomId}] メッセージ処理に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    });
    queues.set(room.roomId, task);
  };

  client.on(RoomEvent.Timeline, (event, room, toStartOfTimeline, _removed, data) => {
    if (!data?.liveEvent || toStartOfTimeline) return;
    if (event.getType() === EventType.RoomMessage) {
      handleMessage(event, room);
      return;
    }
    if (event.getWireType() !== EventType.RoomMessageEncrypted) return;
    event.once(MatrixEventEvent.Decrypted, (decryptedEvent, error) => {
      if (error || decryptedEvent.isDecryptionFailure()) {
        const roomLabel = room?.name || room?.roomId || event.getRoomId() || "Matrix room";
        const now = Date.now();
        if (now - (decryptWarningAt.get(roomLabel) ?? 0) > 60_000) {
          decryptWarningAt.set(roomLabel, now);
          console.warn(`[${roomLabel}] 過去の暗号化メッセージを復号できません。新しい投稿は受信できます。詳細は --debug で確認できます。`);
        }
        return;
      }
      handleMessage(decryptedEvent, room);
    });
  });

  client.on(ClientEvent.Sync, (state) => {
    if (state === SyncState.Prepared) {
      console.log(`接続しました: ${session.userId} · 少人数ルームでは通常投稿、大人数ルームではエージェントへのメンションに応答します。`);
      void persistCrypto();
    }
    else if (state === SyncState.Error) console.error("Matrix 同期エラー。再接続を試みます。");
  });
  client.on(ClientEvent.SyncUnexpectedError, (error) => console.error("Matrix sync error:", error.message));
  await client.startClient({ initialSyncLimit: 10 });

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  let verificationRunning = false;
  let sasAnswer: ((answer: string) => void) | undefined;
  const verifyThisDevice = async () => {
    if (verificationRunning) { console.log("Verification is already in progress."); return; }
    verificationRunning = true;
    try {
      const crypto = client.getCrypto();
      if (!crypto) throw new Error("Matrix crypto is not initialized.");
      const request = await crypto.requestOwnUserVerification();
      console.log("認証済みのElementセッションで、エージェント端末への認証要求を承認してください。承認を待っています…");
      if (request.phase !== VerificationPhase.Ready) {
        await new Promise<void>((resolveReady, rejectReady) => {
          const onChange = () => {
            if (request.phase === VerificationPhase.Ready) { request.off(VerificationRequestEvent.Change, onChange); resolveReady(); }
            else if (request.phase === VerificationPhase.Cancelled) { request.off(VerificationRequestEvent.Change, onChange); rejectReady(new Error("Verification was cancelled on the other device.")); }
          };
          request.on(VerificationRequestEvent.Change, onChange);
          onChange();
        });
      }
      const verifier = await request.startVerification("m.sas.v1");
      const verification = verifier.verify();
      void verification.catch(() => undefined);
      const sas = await new Promise<ShowSasCallbacks>((resolveSas, rejectSas) => {
        verifier.once(VerifierEvent.ShowSas, resolveSas);
        verifier.once(VerifierEvent.Cancel, (error) => rejectSas(error instanceof Error ? error : new Error("Verification cancelled.")));
      });
      console.log("\nElement側と次の絵文字・数字を照合してください。一致する場合のみ y を入力します。");
      if (sas.sas.emoji) console.log(sas.sas.emoji.map(([emoji, name]) => `${emoji} ${name}`).join(" · "));
      if (sas.sas.decimal) console.log(sas.sas.decimal.join(" · "));
      const answer = await new Promise<string>((resolveAnswer) => {
        sasAnswer = resolveAnswer;
        stdout.write("一致していますか？ [y/N] ");
      });
      sasAnswer = undefined;
      if (/^y(es)?$/i.test(answer.trim())) await sas.confirm();
      else sas.mismatch();
      await verification;
      console.log("端末認証が完了しました。Elementのセッション画面を更新してください。");
      void persistCrypto();
    } catch (error) {
      console.error(`端末認証に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    } finally { verificationRunning = false; }
  };
  console.log("\nコマンドを入力してください: /verify または /help");
  stdout.write("matrix> ");
  rl.on("line", (line) => {
    if (sasAnswer) {
      const answer = sasAnswer;
      sasAnswer = undefined;
      answer(line);
    } else if (line.trim() === "/verify") {
      void verifyThisDevice();
    } else if (line.trim() === "/help") {
      console.log("/verify  このエージェント端末をElementの認証済み端末と照合\n/help     コマンド一覧\nCtrl+C    サービス終了");
    } else if (line.trim()) {
      console.log("コマンドが分かりません。/help で一覧を表示します。");
    }
    if (!sasAnswer) stdout.write("matrix> ");
  });

  const snapshotTimer = setInterval(() => { void persistCrypto(); }, 20_000);
  const stop = async () => {
    console.log("\nMatrix サービスを終了します…");
    clearInterval(snapshotTimer);
    rl.close();
    client.stopClient();
    await tokenWriteQueue;
    await persistCrypto();
    await stopMcpServers();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
