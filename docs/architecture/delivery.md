# Delivery mechanisms

Merging integrates and a version tag ships. A change reaching `main` does not deploy production. This is the current release arrangement, not a restriction on future hosting technology.

Opening a PR or pushing a version tag starts an obligation to watch it with `bun scripts/ci-watch.ts` through its terminal state. Exit 0 means landed, 1 means failed, and 2 means pending. Inspect failed checks, repair them, and watch again. A published release without its deployment is failed delivery.

PRs outside `.github/workflows/` queue themselves after checks pass. A PR editing workflow files cannot be queued by `GITHUB_TOKEN` and must be merged by an authorized human identity. Preserve that operational restriction when changing workflow tooling.
