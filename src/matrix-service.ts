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
import type { ChatMessage } from "./openai.js";
import { openAISettings, streamOpenAI } from "./openai.js";

const homeserver = (process.env.MATRIX_HOMESERVER_URL ?? "https://matrix.org").replace(/\/+$/, "");
const trigger = process.env.MATRIX_TRIGGER ?? "!ai ";
const systemPrompt = process.env.SYSTEM_PROMPT ?? "You are a helpful assistant.";
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

async function login() {
  const discoveryClient = createClient({ baseUrl: homeserver });
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
        const identity = await createClient({ baseUrl: homeserver, accessToken: refreshed.access_token, deviceId: saved.deviceId }).whoami();
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

  const client = createClient({ baseUrl: homeserver, accessToken: result.access_token, deviceId: oauth.context.deviceId });
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

export async function runMatrixService(): Promise<void> {
  console.log(`Matrix サービスを開始します (${homeserver})`);
  console.log(`LLM: ${openAISettings.baseUrl} · ${openAISettings.model}`);
  console.log(`反応プレフィックス: ${JSON.stringify(trigger)}`);
  console.log("初回は Matrix アカウントをブラウザで承認してください。終了は Ctrl+C。\n");

  const session = await login();
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
  const seen = new Set<string>();
  const queues = new Map<string, Promise<void>>();
  const handleMessage = (event: import("matrix-js-sdk").MatrixEvent, room: import("matrix-js-sdk").Room | undefined) => {
    if (event.getType() !== EventType.RoomMessage) return;
    if (event.getSender() === session.userId) return;
    const content = event.getContent<{ msgtype?: string; body?: string }>();
    if (content.msgtype !== "m.text" || !content.body || !room) return;
    const body = content.body.trimStart();
    const triggerText = trigger.trimEnd();
    const afterTrigger = body.slice(triggerText.length);
    const matchesTrigger = body === triggerText || (body.startsWith(triggerText) && /^\s/u.test(afterTrigger));
    console.log(`[${room.name || room.roomId}] incoming message from ${event.getSender()} (${matchesTrigger ? "trigger matched" : "ignored"})`);
    if (!matchesTrigger) return;
    const eventId = event.getId();
    if (eventId && seen.has(eventId)) return;
    if (eventId) seen.add(eventId);
    const prompt = afterTrigger.trim();
    if (!prompt) return;

    const prior = queues.get(room.roomId) ?? Promise.resolve();
    const task = prior.then(async () => {
      console.log(`[${room.name || room.roomId}] ${event.getSender()}: ${prompt}`);
      let history = conversations.get(room.roomId);
      if (!history) { history = [{ role: "system", content: systemPrompt }]; conversations.set(room.roomId, history); }
      history.push({ role: "user", content: prompt });
      try {
        const answer = await streamOpenAI(history, () => undefined);
        history.push({ role: "assistant", content: answer });
        await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: answer });
        console.log("  -> replied");
      } catch (error) {
        history.pop();
        const message = error instanceof Error ? error.message : String(error);
        console.error(`LLM/Matrix reply failed: ${message}`);
        await client.sendMessage(room.roomId, { msgtype: MsgType.Text, body: "すみません。LLM への接続中にエラーが発生しました。" }).catch(console.error);
      }
    }).catch(console.error);
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
        console.error(`[${room?.name || room?.roomId || event.getRoomId()}] encrypted message could not be decrypted: ${error?.message ?? decryptedEvent.decryptionFailureReason ?? "unknown error"}`);
        return;
      }
      handleMessage(decryptedEvent, room);
    });
  });

  client.on(ClientEvent.Sync, (state) => {
    if (state === SyncState.Prepared) {
      console.log(`接続しました: ${session.userId} · Element から ${JSON.stringify(trigger)}で話しかけてください。`);
      void persistCrypto();
    }
    else if (state === SyncState.Error) console.error("Matrix 同期エラー。再接続を試みます。");
  });
  client.on(ClientEvent.SyncUnexpectedError, (error) => console.error("Matrix sync error:", error.message));
  await client.startClient({ initialSyncLimit: 10 });

  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  let verificationRunning = false;
  const verifyThisDevice = async () => {
    if (verificationRunning) { console.log("Verification is already in progress."); return; }
    verificationRunning = true;
    try {
      const crypto = client.getCrypto();
      if (!crypto) throw new Error("Matrix crypto is not initialized.");
      const request = await crypto.requestOwnUserVerification();
      console.log("Accept the verification request on a verified Element session; waiting...");
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
      const sas = await new Promise<ShowSasCallbacks>((resolveSas, rejectSas) => {
        verifier.once(VerifierEvent.ShowSas, resolveSas);
        verifier.once(VerifierEvent.Cancel, (error) => rejectSas(error instanceof Error ? error : new Error("Verification cancelled.")));
      });
      console.log("\nCompare the emoji/numbers below with Element. Confirm only if they match:");
      if (sas.sas.emoji) console.log(sas.sas.emoji.map(([emoji, name]) => `${emoji} ${name}`).join(" · "));
      if (sas.sas.decimal) console.log(sas.sas.decimal.join(" · "));
      const answer = await rl.question("Do they match? [y/N] ");
      if (/^y(es)?$/i.test(answer.trim())) await sas.confirm();
      else sas.mismatch();
      await verification;
      console.log("Device verification complete. Refresh Element's sessions page.");
      void persistCrypto();
    } catch (error) {
      console.error("Device verification failed:", error instanceof Error ? error.message : String(error));
    } finally { verificationRunning = false; }
  };
  void (async () => {
    for await (const line of rl) {
      if (line.trim() === "/verify") void verifyThisDevice();
      else if (line.trim() === "/help") console.log("Commands: /verify (verify this agent device), /help");
    }
  })().catch(console.error);

  const snapshotTimer = setInterval(() => { void persistCrypto(); }, 20_000);
  const stop = async () => {
    console.log("\nMatrix サービスを終了します…");
    clearInterval(snapshotTimer);
    rl.close();
    client.stopClient();
    await tokenWriteQueue;
    await persistCrypto();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
