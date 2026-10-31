# GitHub publishing and installation

This project is prepared for `timekillr/value-forge-decky` on GitHub.
The release workflow builds, tests, and publishes matching stable versions.

## Install from Gaming Mode

Use a public repository so Decky can download the asset without GitHub login.
After the first release is published, open Decky Settings → Developer → Install
Plugin from URL in Gaming Mode. Enter the following URL:

```text
https://github.com/timekillr/value-forge-decky/releases/latest/download/ValueForge.zip
```

The URL points to the compiled installable ZIP, not GitHub's generated source
archive. Every release uses the same asset name, so the latest-install URL stays
unchanged. Decky downloads and installs it after its normal confirmation; Desktop
Mode and a browser download are unnecessary. This does not enable silent updates
or add this plugin to the official Decky store. Reuse the URL for later updates.

The plugin folder remains `memory-deck-session`. Its settings are outside the
installation folder, so updating preserves saved groups. After the first rename
from Memory Deck Session, restart Decky Loader once or reboot to clear its old
loaded name/backend. Future Value Forge updates use the normal install flow. No game/session data,
memory snapshots, or user settings are included in the published project.

## Initial repository setup

When importing through the browser, the one-time `source-bootstrap.zip` bundle
is expanded and committed by the first manual workflow run, then removed from
the working tree. The workflow itself is installed separately. Subsequent
releases build directly from the normal source files.


Create a public repository named `value-forge-decky` in the timekillr GitHub account.
Push the project source, including `.github/workflows/release.yml`, package-lock,
vendored native sources, licenses, and source notices. Keep the existing GPL
license and upstream attribution. Compiled `dist/` and `bin/` directories are
ignored by Git because the release workflow builds them.

If starting with the supplied source bundle, extract it, open its
`memory-deck-session` folder, initialize Git, and push the files to the new empty
repository. If publishing from the development checkout, add your repository as
a new remote; `origin` currently refers to the upstream Memory Deck author.
Publish to your own repository, not the upstream project.

## Publish a version

1. Update the version in package.json and package-lock.json together. The current
   prepared version is 0.5.0.
2. Commit and push the intended source to your repository.
3. Create and push a matching version tag, such as `v0.5.0`. Alternatively, open
   GitHub Actions → Build and publish Decky release → Run workflow, select the
   intended branch, and enter the matching tag. The first run can create the tag.
4. Wait for **Build and publish Decky release** to finish.

The workflow checks the version, installs pinned dependencies, compiles libscanmem
for Linux x86-64, builds the frontend, runs the backend and UI checks, and creates
the installable ZIPs. It then publishes a release with:

- `ValueForge.zip` — fixed name for the permanent install URL.
- `ValueForge-0.5.0.zip` — versioned asset (changes with the version).
- `SHA256SUMS` — SHA-256 hashes for both ZIP filenames.

GitHub supplies the workflow token; do not add personal access tokens to source.
The workflow asks for repository contents write access to create the release.
Run it in your repository with Actions enabled. For a manual run, the tag
points to the exact source commit selected for that workflow run.

To retry a failed run before publication, rerun it in Actions. Once a release is
published, publish fixes under a new version/tag instead of replacing its files.
The workflow intentionally refuses to overwrite an existing release.

## Local release packaging

```bash
npm ci
npm run build:native
npm run check
npm run release
```

Outputs are in `artifacts/`. The fixed-name and versioned ZIPs are byte-identical.
The original `npm run package` still creates just the versioned installer.

References:

- Decky URL installation: https://github.com/SteamDeckHomebrew/decky-loader#-plugins
- GitHub latest asset links: https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases
