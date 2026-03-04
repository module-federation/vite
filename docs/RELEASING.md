# Releasing

This repo uses Changesets for versioning, and publishes to npm via GitHub Actions trusted publishing.

## Flow

1. Add Changesets in feature PRs
   - `pnpm changeset`
2. Create + merge the release PR
   - GitHub Actions: `Release Pull Request`
3. Create a GitHub Release for the merge commit
   - Tag format: `<package.json version>` (example: `1.11.0`)
   - Stable: mark as a normal release
   - Pre-release: mark as a prerelease on the same stable tag (example: `1.12.0`)
4. GitHub Actions publishes to npm
   - Workflow: `Publish (GitHub Release)` (`.github/workflows/publish-on-release.yml`)
   - Dist-tag:
     - Release trigger: `latest` for stable releases; `next` for prereleases
     - Manual trigger (`workflow_dispatch`): `latest` or `next` from workflow input
   - Pre-release versioning:
     - On `prereleased` events, workflow patches `package.json` to `<base>-next.<N>` before publish.
     - `<N>` increments from current npm `next` dist-tag when prefix matches, otherwise starts at `1`.
   - Existing version handling:
     - If the exact version is already on npm and already under the target dist-tag, publish is skipped (idempotent rerun).
     - If the version already exists but target dist-tag points elsewhere, workflow fails (no republish, no dist-tag promotion).
     - Trusted Publishers (OIDC) do not support dist-tag promotion (`npm dist-tag add`) without publishing.
   - Uses npm trusted publishing (OIDC + provenance)

## Manual Publish (No GitHub Release)

Use the `Publish (GitHub Release)` workflow with `Run workflow`:

- `version=latest`: publish current `branch` head with `latest` tag.
- `version=next`: generate a snapshot version (`changeset version --snapshot`) and publish with `next` tag.

## Notes

- Publish job hard-fails if `tag_name` does not match `package.json` version (and tags must not start with `v`).
- npm trusted publisher must be configured for this package and workflow file:
  - repo: `module-federation/vite`
  - workflow: `.github/workflows/publish-on-release.yml`
  - environment: `publish`
- Promotion flow: prerelease publishes `-next.N`; stable release publishes base stable version to `latest`.
