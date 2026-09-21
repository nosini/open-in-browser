#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
# Key path is overridable so CI can supply a decoded secret without committing it.
KEY_FILE="${EXTENSION_KEY_FILE:-$SCRIPT_DIR/extension.pem}"
CRX_OUT="$SCRIPT_DIR/open-in-browser.crx"

# ── Check tools ───────────────────────────────────────────────────────────────
# crx3.py writes the signed package itself, so no browser is needed here.

for tool in python3 openssl; do
  if ! command -v "$tool" &>/dev/null; then
    echo "Error: $tool is required but was not found."
    exit 1
  fi
done

# ── Generate key if needed ────────────────────────────────────────────────────

if [[ ! -f "$KEY_FILE" ]]; then
  echo "==> Generating signing key: $KEY_FILE"
  (umask 077 && openssl genrsa -out "$KEY_FILE" 2048 2>/dev/null)
  echo "    Keep this file — you need it to publish updates to the same extension ID."
fi

# ── Pack the extension ────────────────────────────────────────────────────────

echo "==> Packing extension..."
EXT_ID="$(python3 "$SCRIPT_DIR/crx3.py" "$EXT_DIR" "$KEY_FILE" "$CRX_OUT")"
echo "==> Done: $CRX_OUT"

echo ""
echo "To install in Brave:"
echo "  1. Go to brave://extensions"
echo "  2. Enable Developer mode"
echo "  3. Drag and drop $CRX_OUT onto the page"
echo ""
echo "Extension ID (derived from $KEY_FILE):"
echo "  $EXT_ID"
echo ""
echo "Update the native host manifest with this ID if you haven't already:"
echo "  sed -i 's/EXTENSION_ID_HERE/$EXT_ID/' \\"
echo "    \"\$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/open_in_firefox.json\""
echo ""
