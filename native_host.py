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


def parse_domains_file():
    """
    Parse domains.txt into browser aliases and domain entries.
    Returns (aliases dict, entries list of {domain, browser} dicts).
    """
    aliases = {}
    entries = []

    if not os.path.exists(DOMAINS_FILE):
        send_message({"error": f"domains.txt not found at {DOMAINS_FILE}"})
        return aliases, entries

    section = None
    with open(DOMAINS_FILE, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
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
                domain = parts[0]
                browser = parts[1].strip() if len(parts) >= 2 else "firefox"
                entries.append({"domain": domain, "browser": browser})

    return aliases, entries


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
        aliases, entries = parse_domains_file()
        resolved = [
            {"domain": e["domain"], "browser": aliases.get(e["browser"], e["browser"])}
            for e in entries
        ]
        send_message({
            "domains": resolved,
            "browsers": aliases,
        })

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
