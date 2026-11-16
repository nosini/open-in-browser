#!/usr/bin/env python3
"""
Native messaging host for the "Open in Browser" extension.
Reads domains.txt and launches the appropriate browser.
"""
import json
import os
import shlex
import struct
import subprocess
import sys
from urllib.parse import urlsplit

CONFIG_DIR_NAME = "open-in-browser"

# Bump when a change to the extension<->host messages breaks older versions.
# Hosts installed before this constant existed speak protocol 1.
PROTOCOL_VERSION = 2


def default_domains_file():
    """
    Locate domains.txt. install.sh copies this script to ~/.local/bin, so the
    config lives in the XDG config directory rather than beside the script; a
    plain checkout that was never installed still works from its own directory.
    """
    override = os.environ.get("OPEN_IN_BROWSER_DOMAINS")
    if override:
        return override

    config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    config_path = os.path.join(config_home, CONFIG_DIR_NAME, "domains.txt")
    if os.path.exists(config_path):
        return config_path

    local_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "domains.txt")
    if os.path.exists(local_path):
        return local_path

    # Neither exists: report the installed location in the "not found" error.
    return config_path


DOMAINS_FILE = default_domains_file()


def read_message():
    """Read a native messaging message from stdin."""
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    length = struct.unpack("@I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def send_message(payload):
    """Send a native messaging message to stdout."""
    encoded = json.dumps(payload).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def send_error(error):
    """
    Report an error, including the protocol so an extension can tell a broken
    current host from an outdated one that does not know this field.
    """
    send_message({"protocol": PROTOCOL_VERSION, "status": "error", "error": error})


def normalize_domain(domain):
    """
    Normalize a domain token so matching (and the extension's DNR batch) is
    predictable: lowercase, strip a trailing '.', strip a leading '*.' or '.'
    prefix. Returns "" for tokens that are empty after normalization.
    """
    domain = domain.strip().lower().rstrip(".")
    if domain.startswith("*."):
        domain = domain[2:]
    elif domain.startswith("."):
        domain = domain[1:]
    return domain


def strip_inline_comment(line):
    """Strip an unquoted comment, preserving shell quotes and escapes verbatim."""
    quote = None
    escaped = False
    comment_start = True
    for index, char in enumerate(line):
        if escaped:
            escaped = False
        elif char == "\\" and quote != "'":
            escaped = True
        elif quote:
            if char == quote:
                quote = None
        elif char in ("'", '"'):
            quote = char
        elif char == "#" and comment_start:
            return line[:index].rstrip()
        elif char.isspace():
            comment_start = True
            continue
        comment_start = False
    return line


def parse_domains_file():
    """
    Parse domains.txt into browser aliases and domain entries.
    Returns (aliases dict, entries list of {domain, browser} dicts, error or None).
    """
    aliases = {}
    entries = []

    if not os.path.exists(DOMAINS_FILE):
        return aliases, entries, f"domains.txt not found at {DOMAINS_FILE}"

    section = None
    with open(DOMAINS_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue

            # Comments start after unquoted, unescaped whitespace; hashes inside
            # quoted arguments or command tokens must survive for shlex.split().
            line = strip_inline_comment(line).strip()
            if not line:
                continue

            if line.lower() == "[browsers]":
                section = "browsers"
                continue
            elif line.lower() == "[domains]":
                section = "domains"
                continue

            parts = line.split(maxsplit=1)

            if section == "browsers" and len(parts) == 2:
                aliases[parts[0]] = parts[1].strip()
            elif section == "domains":
                domain = normalize_domain(parts[0])
                if not domain:
                    continue
                browser = parts[1].strip() if len(parts) >= 2 else "firefox"
                entries.append({"domain": domain, "browser": browser})

    return aliases, entries, None


def match_domain(hostname, entries):
    """
    Return the most specific entry matching hostname, or None. A domain also
    matches its subdomains; the longest matching domain wins.
    """
    best = None
    for entry in entries:
        domain = entry["domain"]
        if hostname == domain or hostname.endswith("." + domain):
            if best is None or len(domain) > len(best["domain"]):
                best = entry
    return best


def resolve_browser(browser, aliases):
    """
    Resolve the first word of a browser field as an alias, appending any extra
    arguments after the alias's command. Fields that do not start with a known
    alias are commands from domains.txt and are used as-is.
    """
    parts = shlex.split(browser)
    if parts and parts[0] in aliases:
        return " ".join([aliases[parts[0]], *(shlex.quote(part) for part in parts[1:])])
    return browser


def open_in_browser(url, browser):
    """
    Launch the given browser with url, detached from this process. stdin and
    stdout are the native-messaging pipe, so the child must not inherit them.
    """
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Only http and https URLs can be opened.")
    command = shlex.split(browser)
    if not command:
        raise ValueError("no browser command configured")
    command.append(url)
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    # Catch commands that fail immediately (a missing Flatpak app, a wrapper
    # that exits 1). A browser that stays running is handed off successfully.
    try:
        returncode = process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return
    if returncode != 0:
        raise RuntimeError(f"browser command exited with status {returncode}")


def handle_message(message):
    action = message.get("action")

    if action == "get_domains":
        aliases, entries, error = parse_domains_file()
        if error:
            send_error(error)
            return
        resolved = [
            {"domain": e["domain"], "browser": resolve_browser(e["browser"], aliases)}
            for e in entries
        ]
        send_message({
            "protocol": PROTOCOL_VERSION,
            "domains": resolved,
            "browsers": aliases,
        })

    elif action == "open":
        handle_open(message)

    else:
        send_error(f"Unknown action: {action}")


def handle_open(message):
    url = message.get("url", "")
    if not isinstance(url, str) or not url.strip():
        send_error("No URL given.")
        return
    url = url.strip()

    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        send_error("Only http and https URLs can be opened.")
        return

    aliases, entries, error = parse_domains_file()
    if error:
        send_error(error)
        return

    # The extension may name a [browsers] alias; anything else is rejected
    # rather than executed as a caller-supplied command.
    alias = message.get("browser")
    if alias:
        if not isinstance(alias, str) or alias not in aliases:
            send_error(f"Unknown browser alias: {alias}")
            return
        command = aliases[alias]
    else:
        entry = match_domain(parsed.hostname.lower(), entries)
        if not entry:
            send_error(f"No browser configured for {parsed.hostname}")
            return
        command = resolve_browser(entry["browser"], aliases)

    try:
        open_in_browser(url, command)
    except Exception as error:
        send_error(str(error))
    else:
        send_message({"status": "ok"})


def main():
    try:
        message = read_message()
        if not message:
            return
        handle_message(message)
    except Exception as error:
        # Config/read errors must be reported to the extension, not left as a
        # crash that looks like a missing installation.
        try:
            send_error(str(error))
        except Exception:
            pass


if __name__ == "__main__":
    main()
