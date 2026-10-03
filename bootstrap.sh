#!/usr/bin/env bash
# Installs the native messaging host straight from a release, without a
# checkout: downloads install.sh and the files it needs, then runs it.
#
#   curl -fsSL https://raw.githubusercontent.com/nosini/open-in-browser/refs/tags/v1.3/bootstrap.sh \
#     | bash -s -- --ref v1.3 --id <extension-id>
#
# The extension's setup page shows this command with both values filled in.

# Override the raw-file repository base URL, including any owner/repository path.
REPOSITORY="${OPEN_IN_BROWSER_REPOSITORY:-https://raw.githubusercontent.com/nosini/open-in-browser}"
FILES=(install.sh native_host.py domains.txt.example)

die() {
  echo "Error: $*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: bootstrap.sh --id EXTENSION_ID [--ref REF] [--profile USER_DATA_DIR]...

Downloads install.sh, native_host.py and domains.txt.example from
$REPOSITORY
and runs install.sh with the given extension ID.

  --id EXTENSION_ID   ID shown on the extension's setup page. Required.
  --ref REF           Release tag (v1.3) or branch to download from. Use the
                      tag matching the installed extension; defaults to main.
  --profile DIR       Passed through to install.sh. May be repeated.
EOF
}

# Everything runs from main, called on the last line, so a download cut short
# by a dropped connection can never execute half a script.
main() {
  set -euo pipefail

  local ref="main" id=""
  local passthrough=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --id)
        [[ $# -ge 2 ]] || die "--id needs a value."
        id="$2"
        shift 2
        ;;
      --ref)
        [[ $# -ge 2 ]] || die "--ref needs a value."
        ref="$2"
        shift 2
        ;;
      --profile)
        [[ $# -ge 2 ]] || die "--profile needs a value."
        passthrough+=(--profile "$2")
        shift 2
        ;;
      -h|--help)
        usage
        return 0
        ;;
      *)
        usage >&2
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$id" ]] || die "--id is required; copy the full command from the extension's setup page."
  # Checked here too so a typo fails before anything is downloaded.
  [[ "$id" =~ ^[a-p]{32}$ ]] || die "'$id' is not a valid extension ID (32 letters, a-p)."

  local tool
  for tool in curl python3; do
    command -v "$tool" &>/dev/null || die "$tool is required but was not found."
  done

  # Releases are v-prefixed tags; anything else is taken to be a branch.
  local kind="heads"
  [[ "$ref" == v* ]] && kind="tags"
  local base="$REPOSITORY/refs/$kind/$ref"

  local workdir
  workdir="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand now: workdir is local to main
  trap "rm -rf -- '$workdir'" EXIT

  echo "==> Downloading the installer ($ref)"
  local file
  for file in "${FILES[@]}"; do
    # --proto-redir keeps a redirect from downgrading the download to http.
    curl -fsSL --proto-redir =https -o "$workdir/$file" "$base/$file" \
      || die "could not download $base/$file"
  done

  bash "$workdir/install.sh" --id "$id" ${passthrough[@]+"${passthrough[@]}"}
}

main "$@"
