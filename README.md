# Open in Browser

A Chromium extension that opens chosen domains in a different browser. Visit a
configured site in Brave, Chrome or another Chromium-based browser, and it opens
in Firefox (or LibreWolf, or anything else you name) instead. The original
browser never connects to the site.

Right-clicking a link also offers **Open in Browser →** with each browser you
have set up.

## How it works

An extension can't launch programs, so there are two parts:

- **The extension** watches navigations. For a configured domain, it blocks
  the request with a `declarativeNetRequest` rule before any DNS lookup or
  connection happens, then asks the helper to open the URL elsewhere. The tab
  is closed only after the other browser has launched. If the launch fails, the
  tab stays on the blocked page so the URL isn't lost.
- **The helper** (`native_host.py`, installed as
  `~/.local/bin/open-in-browser-host`) is a small Python program. The browser
  starts it through [native messaging][native-messaging]. It reads your
  `domains.txt` and launches the other browser.

Only top-level page loads are blocked. Images, iframes and requests from other
sites to a configured domain are not, since blocking those would break pages
that embed them.

## Requirements

- Linux
- A Chromium-based browser: Chrome, Chromium, Brave (including Brave Origin),
  Vivaldi, Edge or Opera. Browsers installed as Flatpak or Snap usually can't
  start the helper, because their sandbox blocks it.
- `python3`, and `curl` for the one-line install

## Install

1. Download `open-in-browser.crx` from the [latest release][latest].
2. Open your browser's extensions page (`chrome://extensions`,
   `brave://extensions`, …) and turn on **Developer mode**.
3. Drag the `.crx` file onto the page.
4. The extension opens a setup page with a single command, with its ID and
   version already filled in. Paste the command into a terminal. When you
   switch back to the page, it checks again and should confirm that the
   helper works.

The command downloads `install.sh` and `native_host.py` from the release
matching your extension, installs the helper, and registers it with every
Chromium-based browser on your system. The helper only accepts connections
from your extension's ID. If you run the command again, your existing
configuration is kept.

You can reopen the setup page any time from the extension's **Options**. It
also opens by itself when clicking the extension icon fails.

### From a checkout

```sh
./install.sh --id <extension-id>
```

`--id` sets which extension may use the helper. It's shown on the setup page
and on the extensions page. Without `--id`, the script derives the ID from
`extension.pem` if that file exists. Use `--profile DIR` for a browser whose
profile it doesn't find by itself, such as one that has never been launched or
one using a custom `--user-data-dir`. Run `./install.sh --help` for details.

## Configure

The helper reads `~/.config/open-in-browser/domains.txt`, or the same path
under `$XDG_CONFIG_HOME` if that is set. The installer creates it from
[`domains.txt.example`](domains.txt.example):

```ini
[browsers]
# alias      command
firefox      firefox
librewolf    flatpak run io.gitlab.librewolf-community

[domains]
# domain            browser alias or command (default: firefox)
github.com          librewolf
work.example.com    firefox --profile "/home/me/Work Profile"
news.example
```

- A domain also matches its subdomains: `example.com` covers
  `sub.example.com`. A leading `*.` or `.` is ignored.
- Commands are split like a shell command line, so you can quote arguments
  that contain spaces.
- `#` starts a comment, both on its own line and after an entry.
- Every alias in `[browsers]` gets an entry in the right-click menu.

After editing the file, click the extension icon to reload it.

## Building and releasing

`./pack.sh` builds a signed `open-in-browser.crx` from `extension/` with
[`crx3.py`](crx3.py). It needs only `python3` and `openssl`; no browser is
required. It signs with `extension.pem`, and that key determines the extension
ID.

> **Keep `extension.pem` safe.** If it's missing, `pack.sh` creates a new key,
> which gives the extension a new ID. Installed copies won't update to it, and
> the helper won't accept it until you reinstall with the new ID.

Releases are built by [GitHub Actions](.github/workflows/pack.yml): pushing
a tag like `v1.3` tests, packs and signs the extension, then publishes it as a
release. The tag must match the `version` in `extension/manifest.json`. See
[docs/github-actions.md](docs/github-actions.md) for setting up the signing
key.

## Tests

```sh
node --test tests/*.test.js
python3 -m unittest discover -s tests -p 'test_*.py'
```

## License

[AGPL-3.0](LICENSE)

[native-messaging]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
[latest]: https://github.com/nosini/open-in-browser/releases/latest
