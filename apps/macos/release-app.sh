#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
VERSION="${MAMACHI_VERSION:-$(< "$PROJECT_DIR/VERSION")}"
BUILD_NUMBER="${MAMACHI_BUILD_NUMBER:-1}"
DIST_DIR="${MAMACHI_RELEASE_OUTPUT:-$SCRIPT_DIR/dist}"
APP_DIR="$DIST_DIR/Mamachi.app"
ARCHIVE="$DIST_DIR/Mamachi-$VERSION-macos.zip"
CHECKSUM="$ARCHIVE.sha256"

[[ -n "${MAMACHI_SIGN_IDENTITY:-}" ]] || {
    printf '%s\n' "release-app.sh: MAMACHI_SIGN_IDENTITY is required." >&2
    exit 1
}
[[ -n "${MAMACHI_NOTARY_PROFILE:-}" ]] || {
    printf '%s\n' "release-app.sh: MAMACHI_NOTARY_PROFILE is required." >&2
    exit 1
}

mkdir -p "$DIST_DIR"
MAMACHI_SIGN_MODE=developer-id \
MAMACHI_NOTARIZE=1 \
MAMACHI_VERSION="$VERSION" \
MAMACHI_BUILD_NUMBER="$BUILD_NUMBER" \
MAMACHI_APP_OUTPUT="$APP_DIR" \
    "$SCRIPT_DIR/build-app.sh"

codesign --verify --deep --strict --verbose=2 "$APP_DIR"
spctl --assess --type execute --verbose=2 "$APP_DIR"
rm -f "$ARCHIVE" "$CHECKSUM"
ditto -c -k --keepParent "$APP_DIR" "$ARCHIVE"
(
    cd "$DIST_DIR"
    shasum -a 256 "$(basename "$ARCHIVE")" > "$(basename "$CHECKSUM")"
)
printf '%s\n%s\n' "$ARCHIVE" "$CHECKSUM"
