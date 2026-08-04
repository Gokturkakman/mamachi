#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="${MAMACHI_APP_OUTPUT:-$SCRIPT_DIR/dist/Mamachi.app}"
CONTENTS="$APP_DIR/Contents"
RUNTIME_DIR="$CONTENTS/Resources/runtime"
SIGN_MODE="${MAMACHI_SIGN_MODE:-auto}"
NOTARIZE="${MAMACHI_NOTARIZE:-0}"
APP_VERSION="${MAMACHI_VERSION:-$(< "$PROJECT_DIR/VERSION")}"
BUILD_NUMBER="${MAMACHI_BUILD_NUMBER:-1}"
DAEMON_ENTITLEMENTS="${MAMACHI_DAEMON_ENTITLEMENTS:-$SCRIPT_DIR/Resources/Daemon.entitlements}"

fail() {
    printf 'build-app.sh: %s\n' "$*" >&2
    exit 1
}
[[ "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] \
    || fail "MAMACHI_VERSION must be a semantic version."
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] \
    || fail "MAMACHI_BUILD_NUMBER must be a positive integer."

if [[ -n "${MAMACHI_BUILD_BUN:-}" ]]; then
    BUILD_BUN="$MAMACHI_BUILD_BUN"
else
    BUILD_BUN="$(command -v bun || true)"
fi
[[ -n "$BUILD_BUN" && -x "$BUILD_BUN" ]] \
    || fail "Bun is required at build time. Install Bun or set MAMACHI_BUILD_BUN to an executable."
command -v swift >/dev/null || fail "Swift is required to build the macOS application."

find_signing_identity() {
    local prefix="$1"
    security find-identity -v -p codesigning 2>/dev/null \
        | awk -F '"' -v prefix="$prefix" 'index($2, prefix) == 1 { print $2; exit }'
}

case "$SIGN_MODE" in
    auto)
        SIGN_IDENTITY="${MAMACHI_SIGN_IDENTITY:-}"
        if [[ -z "$SIGN_IDENTITY" ]]; then
            SIGN_IDENTITY="$(find_signing_identity "Developer ID Application:")"
        fi
        if [[ -z "$SIGN_IDENTITY" ]]; then
            SIGN_IDENTITY="$(find_signing_identity "Apple Development:")"
        fi
        if [[ -z "$SIGN_IDENTITY" ]]; then
            SIGN_IDENTITY="-"
            printf '%s\n' \
                "build-app.sh: warning: no persistent signing identity found; using ad-hoc signing." \
                "build-app.sh: warning: rebuilt apps may ask for Keychain access again. Configure MAMACHI_SIGN_IDENTITY to prevent this." >&2
        else
            printf 'Signing Mamachi with persistent identity: %s\n' "$SIGN_IDENTITY"
        fi
        ;;
    adhoc)
        SIGN_IDENTITY="-"
        ;;
    none)
        SIGN_IDENTITY=""
        ;;
    developer-id)
        SIGN_IDENTITY="${MAMACHI_SIGN_IDENTITY:-}"
        [[ -n "$SIGN_IDENTITY" ]] \
            || fail "MAMACHI_SIGN_IDENTITY is required when MAMACHI_SIGN_MODE=developer-id."
        ;;
    *)
        fail "MAMACHI_SIGN_MODE must be one of: auto, adhoc, none, developer-id."
        ;;
esac

if [[ -n "$SIGN_IDENTITY" && "$SIGN_IDENTITY" != "-" ]]; then
    security find-identity -v -p codesigning | grep -F "\"$SIGN_IDENTITY\"" >/dev/null \
        || fail "Code-signing identity was not found in the keychain: $SIGN_IDENTITY"
fi

if [[ "$NOTARIZE" != "0" && "$NOTARIZE" != "1" ]]; then
    fail "MAMACHI_NOTARIZE must be 0 or 1."
fi
if [[ "$NOTARIZE" == "1" ]]; then
    [[ "$SIGN_IDENTITY" == "Developer ID Application:"* ]] \
        || fail "Notarization requires a Developer ID Application identity."
    [[ -n "${MAMACHI_NOTARY_PROFILE:-}" ]] \
        || fail "MAMACHI_NOTARY_PROFILE is required when MAMACHI_NOTARIZE=1."
    xcrun notarytool history --keychain-profile "$MAMACHI_NOTARY_PROFILE" >/dev/null \
        || fail "The configured notarytool Keychain profile could not be used."
fi
if [[ -n "${MAMACHI_ENTITLEMENTS:-}" && ! -f "$MAMACHI_ENTITLEMENTS" ]]; then
    fail "MAMACHI_ENTITLEMENTS does not name a readable file: $MAMACHI_ENTITLEMENTS"
fi
if [[ ! -f "$DAEMON_ENTITLEMENTS" ]]; then
    fail "MAMACHI_DAEMON_ENTITLEMENTS does not name a readable file: $DAEMON_ENTITLEMENTS"
fi

swift build -c release --package-path "$SCRIPT_DIR"
BIN_DIR="$(swift build -c release --package-path "$SCRIPT_DIR" --show-bin-path)"
"$BUILD_BUN" run --cwd "$PROJECT_DIR/apps/vscode" build

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$RUNTIME_DIR"
cp "$BIN_DIR/Mamachi" "$CONTENTS/MacOS/Mamachi"
cp "$SCRIPT_DIR/Resources/Info.plist" "$CONTENTS/Info.plist"
cp "$SCRIPT_DIR/Resources/THIRD_PARTY_NOTICES.txt" "$CONTENTS/Resources/THIRD_PARTY_NOTICES.txt"
cp "$SCRIPT_DIR/Resources/AppIcon.icns" "$CONTENTS/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $APP_VERSION" "$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$CONTENTS/Info.plist"
mkdir -p "$CONTENTS/Resources/vscode-extension/dist"
cp "$PROJECT_DIR/apps/vscode/package.json" "$CONTENTS/Resources/vscode-extension/package.json"
cp "$PROJECT_DIR/apps/vscode/dist/extension.js" "$CONTENTS/Resources/vscode-extension/dist/extension.js"

MAMACHI_DAEMON_ENTRY="$PROJECT_DIR/packages/core/src/daemon.ts" \
MAMACHI_DAEMON_OUTPUT="$RUNTIME_DIR/mamachi-daemon" \
MAMACHI_BUILD_ROOT="$PROJECT_DIR" \
BUN_NO_CODESIGN_MACHO_BINARY=1 \
"$BUILD_BUN" -e '
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const legacyPlugin = {
    name: "mamachi:omp-legacy-module",
    setup(build) {
        build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
            path: "omp-legacy-pi-modules",
            namespace: "mamachi-omp-legacy",
        }));
        build.onLoad({ filter: /.*/, namespace: "mamachi-omp-legacy" }, () => ({
            contents: "export const BUNDLED_PI_MODULE_LOADERS = {};",
            loader: "js",
        }));
    },
};
const output = await Bun.build({
    entrypoints: [Bun.env.MAMACHI_DAEMON_ENTRY],
    root: Bun.env.MAMACHI_BUILD_ROOT,
    plugins: [legacyPlugin],
    compile: {
        outfile: Bun.env.MAMACHI_DAEMON_OUTPUT,
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
    },
    throw: false,
});
if (!output.success) {
    for (const log of output.logs) console.error(log);
    process.exit(1);
}
const codingAgent = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent",
    join(Bun.env.MAMACHI_BUILD_ROOT, "packages/core"),
);
const nativeCore = Bun.resolveSync("@oh-my-pi/pi-natives", dirname(codingAgent));
const nativeAddon = Bun.resolveSync(
    `@oh-my-pi/pi-natives-darwin-${process.arch}`,
    dirname(nativeCore),
);
const nativeDirectory = dirname(nativeAddon);
const nativePattern = new RegExp(
    `^pi_natives\\.darwin-${process.arch}(?:-(?:baseline|modern))?\\.node$`,
);
const nativeFiles = readdirSync(nativeDirectory).filter((filename) => nativePattern.test(filename));
if (nativeFiles.length === 0) {
    throw new Error(`No native addon found in ${nativeDirectory}`);
}
for (const filename of nativeFiles) {
    copyFileSync(
        join(nativeDirectory, filename),
        join(dirname(Bun.env.MAMACHI_DAEMON_OUTPUT), filename),
    );
}
'
chmod 755 "$RUNTIME_DIR/mamachi-daemon"
printf '{"daemonVersion":"%s"}\n' "$APP_VERSION" > "$RUNTIME_DIR/daemon-version.json"

if [[ -n "$SIGN_IDENTITY" ]]; then
    APP_SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
    DAEMON_SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
    NATIVE_SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
    if [[ "$SIGN_MODE" == "developer-id" || "$NOTARIZE" == "1" ]]; then
        APP_SIGN_ARGS+=(--options runtime --timestamp)
        DAEMON_SIGN_ARGS+=(--options runtime --timestamp --entitlements "$DAEMON_ENTITLEMENTS")
        NATIVE_SIGN_ARGS+=(--options runtime --timestamp)
    elif [[ -n "${MAMACHI_DAEMON_ENTITLEMENTS:-}" ]]; then
        DAEMON_SIGN_ARGS+=(--entitlements "$DAEMON_ENTITLEMENTS")
    fi
    if [[ -n "${MAMACHI_ENTITLEMENTS:-}" ]]; then
        APP_SIGN_ARGS+=(--entitlements "$MAMACHI_ENTITLEMENTS")
    fi
    for NATIVE_ADDON in "$RUNTIME_DIR"/pi_natives.darwin-*.node; do
        codesign "${NATIVE_SIGN_ARGS[@]}" "$NATIVE_ADDON"
    done
    codesign "${DAEMON_SIGN_ARGS[@]}" "$RUNTIME_DIR/mamachi-daemon"
    codesign "${APP_SIGN_ARGS[@]}" "$APP_DIR"
    codesign --verify --deep --strict "$APP_DIR"
fi

if [[ "$NOTARIZE" == "1" ]]; then
    ARCHIVE="$SCRIPT_DIR/dist/Mamachi-notarization.zip"
    rm -f "$ARCHIVE"
    ditto -c -k --keepParent "$APP_DIR" "$ARCHIVE"
    xcrun notarytool submit "$ARCHIVE" --keychain-profile "$MAMACHI_NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP_DIR"
    xcrun stapler validate "$APP_DIR"
    rm -f "$ARCHIVE"
fi

printf '%s\n' "$APP_DIR"
if [[ "${1:-}" == "--open" ]]; then
    open "$APP_DIR"
elif [[ -n "${1:-}" ]]; then
    fail "Unknown argument: $1"
fi
