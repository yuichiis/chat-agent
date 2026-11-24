import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { EventType, MsgType } from "matrix-js-sdk";
import type { MatrixClient } from "matrix-js-sdk";
import { encryptAttachment } from "matrix-encrypt-attachment";

export const mediaDirectory = process.env.MEDIA_DIR?.trim()
  ? resolve(process.cwd(), process.env.MEDIA_DIR.trim())
  : undefined;

const imageTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export function parseMediaDirectives(text: string, hidePartial = false): { text: string; filenames: string[] } {
  const lines = text.split(/\r?\n/u);
  const endsWithNewline = /\r?\n$/u.test(text);
  const visible: string[] = [];
  const filenames: string[] = [];
  let inCodeBlock = false;

  lines.forEach((line, index) => {
    if (/^[ \t]*(```|~~~)/u.test(line)) {
      inCodeBlock = !inCodeBlock;
      visible.push(line);
      return;
    }
    if (!inCodeBlock) {
      const directive = line.match(/^[ \t]*MEDIA:[ \t]*(.*?)\s*$/iu);
      if (directive) {
        if (directive[1]) filenames.push(directive[1]);
        return;
      }
      if (hidePartial && index === lines.length - 1 && !endsWithNewline) {
        const partial = line.trimStart().toUpperCase();
        if (partial && "MEDIA:".startsWith(partial)) return;
      }
    }
    visible.push(line);
  });

  return {
    text: visible.join("\n").replace(/\n[ \t]*\n(?:[ \t]*\n)+/gu, "\n\n").trim(),
    filenames,
  };
}

async function readAllowedImage(requestedName: string): Promise<{ filename: string; mimeType: string; data: Buffer }> {
  if (!mediaDirectory) throw new Error("画像投稿先が設定されていません。MEDIA_DIRを設定してください。");

  // Drop any directory component from either Windows or POSIX paths before joining.
  const filename = basename(requestedName.replace(/\\/gu, "/")).normalize("NFC").trim();
  if (!filename || filename === "." || filename === ".." || /[\x00-\x1f\x7f]/u.test(filename)) {
    throw new Error("MEDIA: に有効な画像ファイル名を指定してください。");
  }
  const mimeType = imageTypes[extname(filename).toLowerCase()];
  if (!mimeType) throw new Error(`対応していない画像形式です: ${filename}`);

  const root = await realpath(mediaDirectory);
  const resolvedFile = await realpath(resolve(root, filename));
  const pathFromRoot = relative(root, resolvedFile);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error("指定された画像がMEDIA_DIRの外を参照しています。");
  }
  const fileInfo = await stat(resolvedFile);
  if (!fileInfo.isFile()) throw new Error("指定されたパスはファイルではありません。");
  return { filename, mimeType, data: await readFile(resolvedFile) };
}

export async function sendMatrixImage(client: MatrixClient, roomId: string, requestedName: string): Promise<string> {
  const { filename, mimeType, data } = await readAllowedImage(requestedName);
  const encrypted = await client.getCrypto()?.isEncryptionEnabledInRoom(roomId) ?? false;

  if (encrypted) {
    const plaintext = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const attachment = await encryptAttachment(plaintext);
    const hashes = attachment.info.hashes;
    if (!hashes?.sha256) throw new Error("Matrix暗号化添付ファイルのSHA-256ハッシュを生成できませんでした。");
    const uploaded = await client.uploadContent(Buffer.from(attachment.data) as unknown as Blob, {
      type: "application/octet-stream",
      includeFilename: false,
    });
    await client.sendEvent(roomId, EventType.RoomMessage, {
      msgtype: MsgType.Image,
      body: filename,
      filename,
      file: {
        url: uploaded.content_uri,
        key: attachment.info.key,
        iv: attachment.info.iv,
        hashes,
        v: attachment.info.v ?? "v2",
      },
      info: { mimetype: mimeType, size: data.byteLength },
    });
  } else {
    const uploaded = await client.uploadContent(data as unknown as Blob, { name: filename, type: mimeType });
    await client.sendImageMessage(roomId, uploaded.content_uri, { mimetype: mimeType, size: data.byteLength }, filename);
  }

  return filename;
}
