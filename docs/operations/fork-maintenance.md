# Fleet fork maintenance

This fork intentionally updates less often than upstream. It carries fleet-specific stability fixes and only publishes a desktop build after a maintainer deliberately reviews an upstream change.

## Automation boundaries

- `Fork rebase health` runs weekly and dry-runs a rebase onto `pingdotgg/t3code:main`.
- It never pushes, merges, rebases, releases, or changes a running installation.
- A conflict opens or refreshes one GitHub issue; a later healthy check closes it.
- `Fork desktop release` runs only through `workflow_dispatch`.
- Releases use preview versions and contain no automatic-update feed.
- macOS builds are ad-hoc signed, not Apple-notarized. Windows builds are unsigned.
- The official mobile app remains on its normal release track unless a future fork changes the protocol or mobile code.

## Incorporating upstream deliberately

Start from a clean checkout of the fork's default branch:

```sh
git fetch upstream main
git rebase upstream/main
vp install
vp exec vitest run \
  apps/desktop/src/ssh/DesktopSshPasswordPrompts.test.ts \
  packages/ssh/src/tunnel.test.ts \
  scripts/build-desktop-artifact.test.ts
```

Review the upstream changes and resolve conflicts without dropping fleet patches. Push the reviewed branch only after the focused tests pass.

## Cutting a fleet desktop release

Run **Fork desktop release** from the GitHub Actions page on the reviewed commit. The workflow builds:

- macOS arm64 DMG, ZIP, and remote CLI runtime;
- Windows x64 installer with the Linux x64 CLI embedded for WSL;
- Linux x64 AppImage used to produce that CLI runtime.

The workflow publishes these files, the remote runtime archives, and `SHA256SUMS` as a GitHub
prerelease under the canonical `v<version>` tag. Fork desktop builds embed this fork's release
download URL, so SSH-managed environments install the exact matching runtime instead of requesting
a nonexistent preview archive from upstream. Install desktop updates manually; the fork still does
not publish an automatic updater feed.

## Inherited upstream workflows

Keep these disabled in the fork's Actions settings because they depend on upstream infrastructure or private runners:

- `CI`
- `Release`
- `Deploy relay`
- `Mobile EAS Production`

Disabling a workflow is repository state and does not modify upstream YAML, keeping future rebases cleaner.
