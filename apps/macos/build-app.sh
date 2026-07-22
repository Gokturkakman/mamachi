#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="${MAMACHI_APP_OUTPUT:-$SCRIPT_DIR/dist/Mamachi.app}"
CONTENTS="$APP_DIR/Contents"
RUNTIME_DIR="$CONTENTS/Resources/runtime"
SIGN_MODE="${MAMACHI_SIGN_MODE:-adhoc}"
NOTARIZE="${MAMACHI_NOTARIZE:-0}"
APP_VERSION="${MAMACHI_VERSION:-0.1.0}"

fail() {
    printf 'build-app.sh: %s\n' "$*" >&2
    exit 1
}

if [[ -n "${MAMACHI_BUILD_BUN:-}" ]]; then
    BUILD_BUN="$MAMACHI_BUILD_BUN"
else
    BUILD_BUN="$(command -v bun || true)"
fi
[[ -n "$BUILD_BUN" && -x "$BUILD_BUN" ]] \
    || fail "Bun is required at build time. Install Bun or set MAMACHI_BUILD_BUN to an executable."
command -v swift >/dev/null || fail "Swift is required to build the macOS application."

case "$SIGN_MODE" in
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
        security find-identity -v -p codesigning | grep -F "$SIGN_IDENTITY" >/dev/null \
            || fail "Developer ID signing identity was not found in the keychain: $SIGN_IDENTITY"
        ;;
    *)
        fail "MAMACHI_SIGN_MODE must be one of: adhoc, none, developer-id."
        ;;
esac

if [[ "$NOTARIZE" != "0" && "$NOTARIZE" != "1" ]]; then
    fail "MAMACHI_NOTARIZE must be 0 or 1."
fi
if [[ "$NOTARIZE" == "1" ]]; then
    [[ "$SIGN_MODE" == "developer-id" ]] \
        || fail "Notarization requires MAMACHI_SIGN_MODE=developer-id."
    [[ -n "${MAMACHI_NOTARY_PROFILE:-}" ]] \
        || fail "MAMACHI_NOTARY_PROFILE is required when MAMACHI_NOTARIZE=1."
    xcrun notarytool history --keychain-profile "$MAMACHI_NOTARY_PROFILE" >/dev/null \
        || fail "The configured notarytool Keychain profile could not be used."
fi
if [[ -n "${MAMACHI_ENTITLEMENTS:-}" && ! -f "$MAMACHI_ENTITLEMENTS" ]]; then
    fail "MAMACHI_ENTITLEMENTS does not name a readable file: $MAMACHI_ENTITLEMENTS"
fi

swift build -c release --package-path "$SCRIPT_DIR"
BIN_DIR="$(swift build -c release --package-path "$SCRIPT_DIR" --show-bin-path)"
"$BUILD_BUN" run --cwd "$PROJECT_DIR/apps/vscode" build

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$RUNTIME_DIR"
cp "$BIN_DIR/Mamachi" "$CONTENTS/MacOS/Mamachi"
cp "$SCRIPT_DIR/Resources/Info.plist" "$CONTENTS/Info.plist"
cp "$SCRIPT_DIR/Resources/THIRD_PARTY_NOTICES.txt" "$CONTENTS/Resources/THIRD_PARTY_NOTICES.txt"
mkdir -p "$CONTENTS/Resources/vscode-extension/dist"
cp "$PROJECT_DIR/apps/vscode/package.json" "$CONTENTS/Resources/vscode-extension/package.json"
cp "$PROJECT_DIR/apps/vscode/dist/extension.js" "$CONTENTS/Resources/vscode-extension/dist/extension.js"

MAMACHI_DAEMON_ENTRY="$PROJECT_DIR/packages/core/src/daemon.ts" \
MAMACHI_DAEMON_OUTPUT="$RUNTIME_DIR/mamachi-daemon" \
MAMACHI_BUILD_ROOT="$PROJECT_DIR" \
BUN_NO_CODESIGN_MACHO_BINARY=1 \
"$BUILD_BUN" -e '
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
'
chmod 755 "$RUNTIME_DIR/mamachi-daemon"
printf '{"daemonVersion":"%s"}\n' "$APP_VERSION" > "$RUNTIME_DIR/daemon-version.json"

if [[ -n "$SIGN_IDENTITY" ]]; then
    SIGN_ARGS=(--force --sign "$SIGN_IDENTITY")
    if [[ "$SIGN_MODE" == "developer-id" ]]; then
        SIGN_ARGS+=(--options runtime --timestamp)
    fi
    if [[ -n "${MAMACHI_ENTITLEMENTS:-}" ]]; then
        SIGN_ARGS+=(--entitlements "$MAMACHI_ENTITLEMENTS")
    fi
    codesign "${SIGN_ARGS[@]}" "$RUNTIME_DIR/mamachi-daemon"
    codesign "${SIGN_ARGS[@]}" "$APP_DIR"
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
