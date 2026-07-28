import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const encryptionKeyBytes = 32;

export interface EncryptionKeyOptions {
  configuredKey?: string | undefined;
  databasePath: string;
  keyPath?: string | undefined;
  allowPlaintext?: boolean;
}

function validateEncryptionKey(encoded: string, source: string): string {
  const normalized = encoded.trim();
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.byteLength !== encryptionKeyBytes || decoded.toString("base64") !== normalized) {
    throw new Error(`${source} must be base64 for exactly ${encryptionKeyBytes} bytes`);
  }
  return normalized;
}

function readPersistedKey(path: string): string {
  const key = validateEncryptionKey(readFileSync(path, "utf8"), path);
  chmodSync(path, 0o600);
  return key;
}

export function resolveEncryptionKey(options: EncryptionKeyOptions): string | null {
  if (options.configuredKey !== undefined) {
    return validateEncryptionKey(options.configuredKey, "MAMACHI_ENCRYPTION_KEY");
  }
  if (options.allowPlaintext) return null;

  const path = resolve(options.keyPath ?? `${options.databasePath}.key`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    return readPersistedKey(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const generated = randomBytes(encryptionKeyBytes).toString("base64");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${generated}\n`, "utf8");
    return generated;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      return readPersistedKey(path);
    }
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
