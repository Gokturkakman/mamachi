import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();
if (!/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`VERSION is not semantic: ${version}`);
}

for (const path of [
  "package.json",
  "packages/core/package.json",
  "packages/protocol/package.json",
  "apps/vscode/package.json",
]) {
  const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8")) as { version?: unknown };
  if (manifest.version !== version) {
    throw new Error(`${path} has version ${String(manifest.version)}; expected ${version}`);
  }
}

const plist = readFileSync(resolve(root, "apps/macos/Resources/Info.plist"), "utf8");
const plistVersion = plist.match(
  /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
)?.[1];
if (plistVersion !== version) {
  throw new Error(`apps/macos/Resources/Info.plist has version ${String(plistVersion)}; expected ${version}`);
}

console.log(`Mamachi version metadata: ${version}`);
