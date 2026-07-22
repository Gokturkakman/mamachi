#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SCRIPT_DIR/dist/Mamachi.app"
CONTENTS="$APP_DIR/Contents"

swift build -c release --package-path "$SCRIPT_DIR"
BIN_DIR="$(swift build -c release --package-path "$SCRIPT_DIR" --show-bin-path)"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN_DIR/Mamachi" "$CONTENTS/MacOS/Mamachi"

cp "$SCRIPT_DIR/Resources/Info.plist" "$CONTENTS/Info.plist"
cp "$SCRIPT_DIR/Resources/THIRD_PARTY_NOTICES.txt" "$CONTENTS/Resources/THIRD_PARTY_NOTICES.txt"
codesign --force --deep --sign - "$APP_DIR"
printf '%s\n' "$APP_DIR"
if [[ "${1:-}" == "--open" ]]; then
    open "$APP_DIR"
fi
