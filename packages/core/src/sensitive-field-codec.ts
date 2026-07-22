import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_FAMILY = "mamachi:aes256gcm:";
const ENVELOPE_PREFIX = `${ENVELOPE_FAMILY}v1:`;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type SensitiveFieldKey = string | Uint8Array | null;

function decodeBase64(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error(`${label} is not valid base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error(`${label} is not valid base64`);
  }
  return decoded;
}

function normalizeKey(key: Exclude<SensitiveFieldKey, null>): Buffer {
  const decoded = typeof key === "string" ? decodeBase64(key, "MAMACHI_ENCRYPTION_KEY") : Buffer.from(key);
  if (decoded.byteLength !== KEY_BYTES) {
    throw new Error("MAMACHI_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return decoded;
}

export class SensitiveFieldCodec {
  readonly #key: Buffer | null;

  constructor(key: SensitiveFieldKey) {
    this.#key = key === null ? null : normalizeKey(key);
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): SensitiveFieldCodec {
    const configuredKey = environment["MAMACHI_ENCRYPTION_KEY"];
    return new SensitiveFieldCodec(configuredKey === undefined ? null : configuredKey);
  }

  get enabled(): boolean {
    return this.#key !== null;
  }

  isEncrypted(value: string): boolean {
    return value.startsWith(ENVELOPE_FAMILY);
  }

  encode(plaintext: string, field: string): string {
    if (this.#key === null) return plaintext;

    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: AUTH_TAG_BYTES });
    cipher.setAAD(Buffer.from(`${ENVELOPE_PREFIX}${field}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${ENVELOPE_PREFIX}${nonce.toString("base64")}.${authTag.toString("base64")}.${ciphertext.toString("base64")}`;
  }

  decode(stored: string, field: string): string {
    if (!stored.startsWith(ENVELOPE_FAMILY)) return stored;
    if (!stored.startsWith(ENVELOPE_PREFIX)) {
      throw new Error("Unsupported encrypted artifact payload version");
    }
    if (this.#key === null) {
      throw new Error("MAMACHI_ENCRYPTION_KEY is required to decrypt artifact payloads");
    }

    const parts = stored.slice(ENVELOPE_PREFIX.length).split(".");
    if (parts.length !== 3) throw new Error("Encrypted artifact payload is malformed");

    try {
      const nonce = decodeBase64(parts[0]!, "Encrypted artifact nonce");
      const authTag = decodeBase64(parts[1]!, "Encrypted artifact authentication tag");
      const ciphertext = decodeBase64(parts[2]!, "Encrypted artifact ciphertext");
      if (nonce.byteLength !== NONCE_BYTES || authTag.byteLength !== AUTH_TAG_BYTES) {
        throw new Error("Encrypted artifact payload has invalid parameters");
      }
      const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: AUTH_TAG_BYTES });
      decipher.setAAD(Buffer.from(`${ENVELOPE_PREFIX}${field}`, "utf8"));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Encrypted artifact payload authentication failed");
    }
  }
}
