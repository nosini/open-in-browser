#!/usr/bin/env python3
"""
Native messaging host for the "Open in Browser" Brave extension.
Reads domains.txt from the same directory and launches the appropriate browser.
"""
import json
import os
import shlex
import struct
import subprocess
import sys

DOMAINS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "domains.txt")


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


def open_in_browser(url, browser):
    """Launch the given browser with url, detached from this process."""
    command = shlex.split(browser)
    command.append(url)
    subprocess.Popen(
        command,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def main():
    message = read_message()
    if not message:
        sys.exit(0)

    action = message.get("action")

    if action == "get_domains":
        aliases, entries, error = parse_domains_file()
        resolved = [
            {"domain": e["domain"], "browser": aliases.get(e["browser"], e["browser"])}
            for e in entries
        ]
        payload = {
            "domains": resolved,
            "browsers": aliases,
        }
        if error:
            payload["error"] = error
        send_message(payload)

    elif action == "open":
        url = message.get("url", "")
        browser = message.get("browser", "firefox")
        if url:
            open_in_browser(url, browser)
        send_message({"status": "ok"})

    else:
        send_message({"error": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
