#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

# The native messaging host name the extension connects to (background.js).
HOST_NAME="open_in_browser"
# The executable installed for it; browsers launch it by absolute path, so it
# does not need to be on PATH.
HOST_COMMAND="open-in-browser-host"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${XDG_BIN_HOME:-$HOME/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/open-in-browser"
HOST_PATH="$BIN_DIR/$HOST_COMMAND"

EXTENSION_ID=""
EXTRA_DIRS=()

usage() {
  cat <<EOF
Usage: ${BASH_SOURCE[0]##*/} [--id EXTENSION_ID] [--profile USER_DATA_DIR]...

Installs the native messaging host into
  $BIN_DIR
and registers it with every Chromium-based browser found on this system.

  --id EXTENSION_ID    Extension ID allowed to talk to the host. Defaults to
                       the ID derived from extension.pem when that key exists;
                       otherwise a placeholder is written and you re-run this
                       script with --id once the browser shows the real ID.
  --profile DIR        Extra Chromium user data directory to register with,
                       for a browser that has not been launched yet or uses a
                       custom --user-data-dir. May be repeated.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id)
      [[ $# -ge 2 ]] || { echo "Error: --id needs a value." >&2; exit 2; }
      EXTENSION_ID="$2"
      shift 2
      ;;
    --profile)
      [[ $# -ge 2 ]] || { echo "Error: --profile needs a value." >&2; exit 2; }
      EXTRA_DIRS+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ── Work out the extension ID ─────────────────────────────────────────────────

if [[ -z "$EXTENSION_ID" && -f "$SCRIPT_DIR/extension.pem" ]] && command -v python3 &>/dev/null; then
  # The ID is a hash of the signing key's public half, so the packed .crx and
  # this manifest agree without the browser having to be consulted.
  EXTENSION_ID="$(python3 "$SCRIPT_DIR/crx3.py" --id "$SCRIPT_DIR/extension.pem" 2>/dev/null || true)"
fi

if [[ -n "$EXTENSION_ID" && ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: '$EXTENSION_ID' is not a valid extension ID (32 letters, a-p)." >&2
  exit 1
fi

PLACEHOLDER=""
if [[ -z "$EXTENSION_ID" ]]; then
  EXTENSION_ID="EXTENSION_ID_HERE"
  PLACEHOLDER="yes"
fi

# ── Find Chromium-based browsers ──────────────────────────────────────────────

# Every Chromium derivative keeps a "user data directory" holding a `Local
# State` file and a `Default` profile, and reads native messaging manifests
# from `NativeMessagingHosts` inside it. Detecting that layout covers Chrome,
# Chromium, Brave (including Brave Origin), Vivaldi, Opera and Edge, their beta
# and nightly channels, and Flatpak copies, without hardcoding any of them.
find_user_data_dirs() {
  local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  [[ -d "$config_home" ]] && find "$config_home" -maxdepth 4 -name "Local State" -type f -printf '%h\n' 2>/dev/null
  # Flatpak nests the same layout a few levels deeper, under the app ID.
  [[ -d "$HOME/.var/app" ]] && find "$HOME/.var/app" -maxdepth 6 -name "Local State" -type f -printf '%h\n' 2>/dev/null
  return 0
}

TARGETS=()
while IFS= read -r dir; do
  [[ -d "$dir/Default" ]] || continue
  TARGETS+=("$dir")
done < <(find_user_data_dirs | sort -u)

for dir in ${EXTRA_DIRS+"${EXTRA_DIRS[@]}"}; do
  TARGETS+=("${dir%/}")
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "Error: no Chromium-based browser profile found."
  echo "       Launch the browser once so it creates its profile, then re-run"
  echo "       this script, or pass the directory with --profile."
  exit 1
fi

# ── Install the native host ───────────────────────────────────────────────────

echo "==> Installing native host: $HOST_PATH"
mkdir -p "$BIN_DIR"
install -m 755 "$SCRIPT_DIR/native_host.py" "$HOST_PATH"

echo "==> Registering with browsers:"
for user_data_dir in "${TARGETS[@]}"; do
  hosts_dir="$user_data_dir/NativeMessagingHosts"
  mkdir -p "$hosts_dir"
  cat > "$hosts_dir/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "Opens configured domains in another browser",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
  echo "    ${user_data_dir/#$HOME/\~}"
  # Earlier versions registered under a different name and pointed at the
  # checkout; leaving that manifest behind would keep a dead host registered.
  if [[ -f "$hosts_dir/open_in_firefox.json" ]]; then
    rm -f "$hosts_dir/open_in_firefox.json"
    echo "      (removed the old open_in_firefox.json registration)"
  fi
done

# ── Install the configuration ─────────────────────────────────────────────────

mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_DIR/domains.txt" ]]; then
  echo "==> Keeping existing config: $CONFIG_DIR/domains.txt"
elif [[ -f "$SCRIPT_DIR/domains.txt" ]]; then
  # Copy, never move: earlier versions read this file from the checkout.
  cp "$SCRIPT_DIR/domains.txt" "$CONFIG_DIR/domains.txt"
  echo "==> Copied your existing domains.txt to $CONFIG_DIR/domains.txt"
else
  cp "$SCRIPT_DIR/domains.txt.example" "$CONFIG_DIR/domains.txt"
  echo "==> Created config: $CONFIG_DIR/domains.txt"
fi

# ── Instructions ──────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Next steps in your browser:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Open the extensions page (chrome://extensions, brave://extensions, ...)"
echo "2. Enable 'Developer mode'"
echo "3. Drag $SCRIPT_DIR/open-in-browser.crx onto the page,"
echo "   or use 'Load unpacked' and select $SCRIPT_DIR/extension"
echo ""

if [[ -n "$PLACEHOLDER" ]]; then
  echo "The extension ID is not known yet, so the host will refuse connections."
  echo "Copy the ID shown under the extension name, then run:"
  echo ""
  echo "  $SCRIPT_DIR/install.sh --id <extension-id>"
  echo ""
  echo "Or run ./pack.sh first: a packed extension keeps the ID from"
  echo "extension.pem, which this script picks up on its own."
else
  echo "Allowed extension ID: $EXTENSION_ID"
  echo "'Load unpacked' produces a different ID; re-run with --id if you use it."
fi

echo ""
echo "Add your domains to:"
echo "  $CONFIG_DIR/domains.txt"
echo ""
echo "Click the extension icon any time to reload that file."
echo ""
