# Release workflows

Releases are published on GitHub. See [Packing with GitHub Actions](github-actions.md)
for signing-key setup, release tags and downloads.

The original [Forgejo workflow](../.forgejo/workflows/pack.yml) remains available.
It uses a `codeberg-tiny` runner and the Forgejo repository's `EXTENSION_KEY_B64`
secret, with `forgejo.token` for release uploads. Its configuration is independent
of the GitHub workflow; configuring the GitHub secret does not configure Forgejo.
