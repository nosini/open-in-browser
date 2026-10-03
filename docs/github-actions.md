# Packing with GitHub Actions

[The workflow](../.github/workflows/pack.yml) tests the project, runs `pack.sh`,
and publishes the signed `open-in-browser.crx`. It runs on tags starting with
`v`, and on manual runs of `main` or such a tag. Ordinary pushes to `main` do
not trigger it: they produce no release, so there is nothing to sign for, and
the signing key stays out of runs that have no use for it.

Where the `.crx` goes depends on the ref:

- **A `v*` tag** publishes a release for that tag and attaches the `.crx` to it,
  so the download URL is permanent. The release notes quote the extension ID.
  Re-running a tag's workflow reuses the existing release and replaces the
  attached file rather than adding a second copy of it.
- **A manual run of `main`** has no release to attach to, so the `.crx` stays a
  workflow artifact, retained for 30 days.

**A release tag must be `v` + the `version` in `extension/manifest.json`**
(e.g. `v1.3` for `"version": "1.3"`); the workflow refuses anything else. The
extension's setup page builds its install command from its own version, so it
downloads [`bootstrap.sh`](../bootstrap.sh), `install.sh` and `native_host.py`
from that tag, and a mismatched tag would leave that command pointing at
nothing. Bump the manifest version, commit, then tag.

Releases use the automatic per-run `GITHUB_TOKEN`. The job grants it
`contents: write`, which permits creating releases and uploading assets; no
personal access token is needed. See [GitHub's token permissions documentation](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/automatic-token-authentication).

Packing needs no browser: [`crx3.py`](../crx3.py) writes the CRX3 container
(a zip behind a protobuf header holding the public key and signature) and signs
it with `openssl`, so the job installs only `git`, `ca-certificates`, `curl`
(for the release upload), `openssl` and `python3`. The output is
byte-identical for identical sources, and the
extension ID still comes from the key, so it does not change.

The workflow runs on GitHub's `ubuntu-latest` hosted runner in a Debian
container with Node.js 22, with a ten-minute timeout. Runs for the same ref
are serialized so two builds cannot replace the same release asset at once.
If Actions is disabled, enable it under **Settings → Actions → General**.

## Supply the signing key

Reuse the **existing `extension.pem`** that signed your installed extension.
The GitHub workflow requires the existing extension ID
`hmnaaabjcgghcemfngkfgpbgihanbdhb` and rejects a key that produces another ID.
Changing the key changes the extension ID. Keep a separate backup of that key;
the CI secret should not be its only copy.

1. On your own machine, encode the PEM file as a single line:

   ```sh
   base64 -w 0 < extension.pem
   ```

2. Open the repository's **Settings → Secrets and variables → Actions** and add a secret named
   **`EXTENSION_KEY_B64`** with that output as its value. For this repository, the
   [secret settings are here](https://github.com/nosini/open-in-browser/settings/secrets/actions).
   Keep both the PEM and the encoded value out of Git, issues, and build logs.

3. Push a `v*` tag to cut a release, or use **Actions → Pack extension → Run
   workflow** on `main` for a one-off build. Tagged runs leave
   `open-in-browser.crx` on the release page; other runs leave it as an
   artifact on the workflow run.

Base64 is only an encoding for transport. Store the value as a GitHub Actions
secret; see [GitHub's secrets documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).

The workflow exposes the encoded key only to the signing step. That step
decodes it into a temporary directory outside the checkout, with directory
permissions `700` and file permissions `600`, validates it as an unencrypted
RSA private key with the expected extension ID, and passes its path through `EXTENSION_KEY_FILE`. It removes
the encoded environment variable before launching the packer and deletes the
temporary directory when the step exits, including ordinary failures and
cancellation signals. A missing or invalid secret fails the job; CI does not
silently generate a new extension identity. Only the `.crx` is uploaded.

The runner and the code it executes must still be trusted: a process that can
sign using a private key can also read that key. Protect `main` and `v*` tags,
review changes to the workflow and packing script, and keep signing out of
pull-request workflows. External actions are pinned to commits. For stronger
control over who can access the key, use a dedicated runner you administer;
see [GitHub's security guidance](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/security-hardening-for-github-actions).

## Earlier releases

Git tags and release attachments must be migrated separately. Preserve the
existing `v1.1` and `v1.2` tag objects when copying them to GitHub. Copy their
original signed `.crx` attachments as historical releases rather than rebuilding
them with a different key. These versions still contain Codeberg URLs; use
`v1.3` or later for installation entirely from GitHub. Do not move old tags to
new commits to change those URLs.

The retained [Forgejo workflow](../.forgejo/workflows/pack.yml) is separate from
GitHub Actions and still uses its original runner, token and signing secret.
