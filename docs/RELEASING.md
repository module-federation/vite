# Releasing

This repo uses Changesets for versioning, and publishes to npm from GitHub Releases.

## Flow

1. Add Changesets in feature PRs
   - `pnpm changeset`
2. Create + merge the release PR
   - GitHub Actions: `Release Pull Request`
3. Create a GitHub Release for the merge commit
   - Tag format: `v<package.json version>` (example: `v1.11.0`)
   - Stable: mark as a normal release
   - Pre-release: mark as a prerelease; use a pre-id in the version (examples: `v1.12.0-next.1`, `v1.12.0-beta.1`, `v1.12.0-alpha.1`)
4. GitHub Actions publishes to npm
   - Workflow: `Publish (GitHub Release)`
   - Dist-tag: `latest` for stable releases; for prereleases it derives from the version (`next|beta|alpha`, default `next`)

## Notes

- Publish job hard-fails if `tag_name` does not match `package.json` version (after stripping leading `v`).
- Requires `NPM_TOKEN` secret.
