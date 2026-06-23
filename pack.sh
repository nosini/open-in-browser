#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
# Key path is overridable so CI can supply a decoded secret without committing it.
KEY_FILE="${EXTENSION_KEY_FILE:-$SCRIPT_DIR/extension.pem}"
CRX_OUT="$SCRIPT_DIR/open-in-browser.crx"

# ── Find a Chromium-based browser ─────────────────────────────────────────────

BROWSER=""
for candidate in brave brave-browser chromium chromium-browser google-chrome google-chrome-stable \
                 /usr/bin/brave /usr/bin/brave-browser /usr/bin/chromium /usr/bin/chromium-browser; do
  if command -v "$candidate" &>/dev/null; then
    BROWSER="$candidate"
    break
  fi
done

if [[ -z "$BROWSER" ]]; then
  echo "Error: Could not find a Chromium-based browser (Brave, Chromium, or Chrome). Is one installed?"
  exit 1
fi

# ── Generate key if needed ────────────────────────────────────────────────────

if [[ ! -f "$KEY_FILE" ]]; then
  echo "==> Generating signing key: $KEY_FILE"
  openssl genrsa -out "$KEY_FILE" 2048 2>/dev/null
  echo "    Keep this file — you need it to publish updates to the same extension ID."
fi

# ── Pack the extension ────────────────────────────────────────────────────────

echo "==> Packing extension..."

# Brave/Chromium puts the .crx next to the extension directory.
# --no-sandbox lets this run as root inside CI containers; it only affects this
# short one-shot packing process, not any browsing.
"$BROWSER" \
  --pack-extension="$EXT_DIR" \
  --pack-extension-key="$KEY_FILE" \
  --no-sandbox \
  --no-message-box 2>/dev/null || true

BROWSER_CRX="$SCRIPT_DIR/extension.crx"
if [[ -f "$BROWSER_CRX" ]]; then
  mv "$BROWSER_CRX" "$CRX_OUT"
  echo "==> Done: $CRX_OUT"
else
  echo "Error: Expected $BROWSER_CRX was not created. Check that the browser supports --pack-extension."
  exit 1
fi

echo ""
echo "To install in Brave:"
echo "  1. Go to brave://extensions"
echo "  2. Enable Developer mode"
echo "  3. Drag and drop $CRX_OUT onto the page"
echo ""
echo "Note: The Extension ID is derived from your key file."
echo "Update the native host manifest with this ID if you haven't already."
echo ""
