import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEncryptionKey } from "../src/encryption-key.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "mamachi-encryption-key-"));
  temporaryDirectories.push(directory);
  const stateDirectory = join(directory, "state");
  mkdirSync(stateDirectory);
  return { directory, databasePath: join(stateDirectory, "mamachi.sqlite") };
}

describe("resolveEncryptionKey", () => {
  test("generates a private persistent key when no key is configured", () => {
    const { databasePath } = temporaryDatabase();

    const first = resolveEncryptionKey({ databasePath });
    const second = resolveEncryptionKey({ databasePath });

    expect(first).not.toBeNull();
    expect(Buffer.from(first!, "base64")).toHaveLength(32);
    expect(second).toBe(first);
    expect(statSync(`${databasePath}.key`).mode & 0o777).toBe(0o600);
  });

  test("only permits plaintext through the explicit escape hatch", () => {
    const { databasePath } = temporaryDatabase();

    expect(resolveEncryptionKey({ databasePath, allowPlaintext: true })).toBeNull();
    expect(() => statSync(`${databasePath}.key`)).toThrow();
  });

  test("uses a configured key without creating a second key", () => {
    const { databasePath } = temporaryDatabase();
    const configuredKey = Buffer.alloc(32, 0x4d).toString("base64");

    expect(resolveEncryptionKey({ databasePath, configuredKey })).toBe(configuredKey);
    expect(() => statSync(`${databasePath}.key`)).toThrow();
  });

  test("rejects malformed configured keys", () => {
    const { databasePath } = temporaryDatabase();

    expect(() => resolveEncryptionKey({ databasePath, configuredKey: "not-a-key" })).toThrow(
      "MAMACHI_ENCRYPTION_KEY must be base64 for exactly 32 bytes",
    );
  });
});
