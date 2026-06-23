#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

HOST_NAME="open_in_firefox"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NATIVE_HOSTS_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
MANIFEST_PATH="$NATIVE_HOSTS_DIR/$HOST_NAME.json"

# ── Install ───────────────────────────────────────────────────────────────────

echo "==> Making native host executable..."
chmod +x "$SCRIPT_DIR/native_host.py"

echo "==> Creating NativeMessagingHosts directory..."
mkdir -p "$NATIVE_HOSTS_DIR"

echo "==> Writing native host manifest (with placeholder extension ID)..."
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "Opens configured domains in Firefox",
  "path": "$SCRIPT_DIR/native_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID_HERE/"]
}
EOF

# ── Instructions ──────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Almost done — 4 quick steps in Brave:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Open brave://extensions"
echo "2. Enable 'Developer mode' (top right toggle)"
echo "3. Click 'Load unpacked' → select: $SCRIPT_DIR/extension"
echo "4. Copy the Extension ID that appears under the extension name"
echo ""
echo "Then run:"
echo "  sed -i 's/EXTENSION_ID_HERE/<your-id>/' \"$MANIFEST_PATH\""
echo ""
echo "Then add your domains to:"
echo "  $SCRIPT_DIR/domains.txt"
echo ""
echo "Click the extension icon in Brave any time to reload domains.txt."
echo ""
