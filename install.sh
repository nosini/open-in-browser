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
KEY_FILE="${EXTENSION_KEY_FILE:-$SCRIPT_DIR/extension.pem}"

EXTENSION_ID=""
EXTRA_DIRS=()

usage() {
  cat <<EOF
Usage: ${BASH_SOURCE[0]##*/} [--id EXTENSION_ID] [--profile USER_DATA_DIR]...

Installs the native messaging host into
  $BIN_DIR
and registers it with every Chromium-based browser found on this system.

  --id EXTENSION_ID    Extension ID allowed to talk to the host. Without it,
                       an existing registration keeps its allowed ID; otherwise
                       the ID is derived from EXTENSION_KEY_FILE (default:
                       extension.pem). Pass --id if neither exists.
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

# ── Check tools ───────────────────────────────────────────────────────────────

# The host is a Python script: without python3 a browser would find it but
# never manage to start it.
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required but was not found." >&2
  exit 1
fi

# ── Work out the extension ID ─────────────────────────────────────────────────

# An ID passed in came from the extension itself (its setup page, or the
# extensions page), so the extension is already installed.
ID_FROM_EXTENSION=""
if [[ -n "$EXTENSION_ID" ]]; then
  ID_FROM_EXTENSION="yes"
elif [[ -f "$KEY_FILE" ]]; then
  # The ID is a hash of the signing key's public half, so the packed .crx and
  # this manifest agree without the browser having to be consulted.
  EXTENSION_ID="$(python3 "$SCRIPT_DIR/crx3.py" --id "$KEY_FILE" 2>/dev/null || true)"
fi

if [[ -n "$EXTENSION_ID" && ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: '$EXTENSION_ID' is not a valid extension ID (32 letters, a-p)." >&2
  exit 1
fi

# ── Find Chromium-based browsers ──────────────────────────────────────────────

# Every Chromium derivative keeps a "user data directory" holding a `Local
# State` file and at least one `Default` or `Profile N` directory, and reads
# native messaging manifests from `NativeMessagingHosts` inside it. Detecting
# that layout covers Chrome, Chromium, Brave (including Brave Origin), Vivaldi,
# Opera and Edge, their beta and nightly channels, and Flatpak copies, without
# hardcoding any of them.
find_user_data_dirs() {
  local config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
  [[ -d "$config_home" ]] && find "$config_home" -maxdepth 4 -name "Local State" -type f -printf '%h\n' 2>/dev/null
  # Flatpak nests the same layout a few levels deeper, under the app ID.
  [[ -d "$HOME/.var/app" ]] && find "$HOME/.var/app" -maxdepth 6 -name "Local State" -type f -printf '%h\n' 2>/dev/null
  return 0
}

TARGETS=()
while IFS= read -r dir; do
  has_profile=""
  for profile in "$dir"/Default "$dir"/Profile\ *; do
    if [[ -d "$profile" ]]; then
      has_profile="yes"
      break
    fi
  done
  [[ -n "$has_profile" ]] || continue
  TARGETS+=("$dir")
done < <(find_user_data_dirs | sort -u)

for dir in ${EXTRA_DIRS+"${EXTRA_DIRS[@]}"}; do
  TARGETS+=("${dir%/}")
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "Error: no Chromium-based browser profile found." >&2
  echo "       Launch the browser once so it creates its profile, then re-run" >&2
  echo "       this script, or pass the directory with --profile." >&2
  exit 1
fi

# Reads the allowed_origins already registered for a browser, if any.
existing_origins() {
  local manifest="$1"
  [[ -f "$manifest" ]] || return 0
  python3 - "$manifest" <<'PY'
import json
import sys

try:
    with open(sys.argv[1], encoding="utf-8") as file:
        data = json.load(file)
except Exception:
    raise SystemExit(0)

origins = data.get("allowed_origins")
if isinstance(origins, list):
    for origin in origins:
        if isinstance(origin, str):
            print(origin)
PY
}

# Without --id, every browser must either keep an existing registration or have
# a key to derive one from. Fail before writing anything rather than leave a
# placeholder that can never connect.
if [[ -z "$ID_FROM_EXTENSION" && -z "$EXTENSION_ID" ]]; then
  for user_data_dir in "${TARGETS[@]}"; do
    if [[ -z "$(existing_origins "$user_data_dir/NativeMessagingHosts/$HOST_NAME.json")" ]]; then
      echo "Error: no --id given, and no existing host registration to reuse." >&2
      echo "       Pass --id <extension-id> from the extension's setup page," >&2
      echo "       or set EXTENSION_KEY_FILE to the signing key that produced it." >&2
      exit 1
    fi
  done
fi

# ── Install the native host ───────────────────────────────────────────────────

echo "==> Installing native host: $HOST_PATH"
mkdir -p "$BIN_DIR"
install -m 755 "$SCRIPT_DIR/native_host.py" "$HOST_PATH"

echo "==> Registering with browsers:"
for user_data_dir in "${TARGETS[@]}"; do
  hosts_dir="$user_data_dir/NativeMessagingHosts"
  mkdir -p "$hosts_dir"
  manifest="$hosts_dir/$HOST_NAME.json"

  origins=()
  if [[ -z "$ID_FROM_EXTENSION" ]]; then
    while IFS= read -r origin; do
      [[ -n "$origin" ]] && origins+=("$origin")
    done < <(existing_origins "$manifest")
  fi
  if [[ ${#origins[@]} -eq 0 ]]; then
    origins=("chrome-extension://$EXTENSION_ID/")
  fi

  # json.dumps keeps paths containing quotes or backslashes valid.
  python3 - "$HOST_NAME" "$HOST_PATH" "${origins[@]}" > "$manifest" <<'PY'
import json
import sys

json.dump({
    "name": sys.argv[1],
    "description": "Opens configured domains in another browser",
    "path": sys.argv[2],
    "type": "stdio",
    "allowed_origins": sys.argv[3:],
}, sys.stdout, indent=2)
sys.stdout.write("\n")
PY

  echo "    ${user_data_dir/#$HOME/\~}"
  if [[ "$user_data_dir" == "$HOME/.var/app/"* ]]; then
    echo "      (Flatpak: the sandbox usually cannot start programs outside it)"
  fi
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

if [[ -n "$ID_FROM_EXTENSION" ]]; then
  # The extension is already installed, and SCRIPT_DIR may be a temporary
  # download (bootstrap.sh), so point back to the browser, not to files here.
  echo "The helper is registered for extension $EXTENSION_ID."
  echo "Return to the extension's setup page, or click its icon, to connect."
else
  echo "1. Open the extensions page (chrome://extensions, brave://extensions, ...)"
  echo "2. Enable 'Developer mode'"
  echo "3. Drag $SCRIPT_DIR/open-in-browser.crx onto the page,"
  echo "   or use 'Load unpacked' and select $SCRIPT_DIR/extension"
  echo ""

  if [[ -n "$EXTENSION_ID" ]]; then
    echo "Allowed extension ID: $EXTENSION_ID"
    echo "'Load unpacked' produces a different ID; re-run with --id if you use it."
  else
    echo "Kept the existing extension registration."
  fi
fi

echo ""
echo "Add your domains to:"
echo "  $CONFIG_DIR/domains.txt"
echo ""
echo "Click the extension icon any time to reload that file."
echo ""
