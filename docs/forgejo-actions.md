# Packing with Forgejo Actions

[The workflow](../.forgejo/workflows/pack.yml) tests the project, runs `pack.sh`,
and publishes the signed `open-in-browser.crx`. It runs on pushes to `main`,
tags starting with `v`, and manual runs on those refs.

Where the `.crx` goes depends on the ref:

- **A `v*` tag** publishes a release for that tag and attaches the `.crx` to it,
  so the download URL is permanent. The release notes quote the extension ID.
  Re-running a tag's workflow reuses the existing release and replaces the
  attached file rather than adding a second copy of it.
- **Any other ref** has no release to attach to, so the `.crx` stays a workflow
  artifact, retained for 30 days.

Releases use the automatic per-run token (`forgejo.token`), which has write
access to the repository, so they need no extra secret. If the instance
restricts that token, point `FORGEJO_TOKEN` in the release step at a repository
secret holding a token with the `write:repository` scope instead.

Packing needs no browser: [`crx3.py`](../crx3.py) writes the CRX3 container
(a zip behind a protobuf header holding the public key and signature) and signs
it with `openssl`, so the job installs only `git`, `ca-certificates`, `openssl`
and `python3`. The output is byte-identical for identical sources, and the
extension ID still comes from the key, so it does not change.

Enable Actions in the repository's **Settings → Units**. The workflow targets
Codeberg's hosted `codeberg-small` runner with a five-minute limit and uses a
Debian container with Node.js. See the current
[hosted runner availability and limits](https://codeberg.org/actions/meta).
For a self-hosted runner, change `runs-on` to its label and use a container
runner that supports the workflow's `container.image` setting.

## Supply the signing key

Reuse the **existing `extension.pem`** that signed your installed extension.
Changing the key changes the extension ID. Keep a separate backup of that key;
the CI secret should not be its only copy.

1. On your own machine, encode the PEM file as a single line:

   ```sh
   base64 -w 0 < extension.pem
   ```

2. Open the repository's **Settings → Actions → Secrets** and add a secret named
   **`EXTENSION_KEY_B64`** with that output as its value. For this repository, the
   [secret settings are here](https://codeberg.org/nosini/open-in-firefox/settings/actions/secrets).
   Keep both the PEM and the encoded value out of Git, issues, and build logs.

3. Push a `v*` tag to cut a release, or use **Actions → Pack extension → Run
   workflow** on `main` for a one-off build. Tagged runs leave
   `open-in-browser.crx` on the release page; other runs leave it as an
   artifact on the workflow run.

Base64 is only an encoding for transport. Forgejo stores Actions secrets
encrypted in its database and supplies them to the runner when needed; see
[Forgejo's secrets documentation](https://forgejo.org/docs/latest/user/actions/basic-concepts/#secrets).

The workflow exposes the encoded key only to the signing step. That step
decodes it into a temporary directory outside the checkout, with directory
permissions `700` and file permissions `600`, validates it as an unencrypted
RSA private key, and passes its path through `EXTENSION_KEY_FILE`. It removes
the encoded environment variable before launching the packer and deletes the
temporary directory when the step exits, including ordinary failures and
cancellation signals. A missing or invalid secret fails the job; CI does not
silently generate a new extension identity. Only the `.crx` is uploaded.

The runner and the code it executes must still be trusted: a process that can
sign using a private key can also read that key. Protect `main` and `v*` tags,
review changes to the workflow and packing script, and keep signing out of
pull-request workflows. External actions are pinned to commits. For stronger
control over who can access the key, use a dedicated runner you administer;
see [Forgejo's runner security guidance](https://forgejo.org/docs/latest/user/actions/security/).
