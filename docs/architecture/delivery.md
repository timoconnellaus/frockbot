# Delivery mechanisms

Merging integrates and a version tag ships. A change reaching `main` does not deploy production. This is the current release arrangement, not a restriction on future hosting technology.

Opening a PR or pushing a version tag starts an obligation to watch it with `bun scripts/ci-watch.ts` through its terminal state. Exit 0 means landed, 1 means failed, and 2 means pending. Inspect failed checks, repair them, and watch again. A published release without its deployment is failed delivery.

## Production secrets

`apps/cloudflare/src/production-secrets.ts` is the manifest of every string setting the Worker reads off `env`. Each name sits in exactly one of three lists: required (production is broken without it, so the deploy fails), optional (the deploy proceeds and says what stays shut), or not deployed as a secret (a `vars` entry, or a door only a test harness opens). Each entry carries the sentence an operator needs when a deploy stops.

The release workflow uses the manifest twice. `bun scripts/check-production-secrets.ts check` runs in the deploy job's validation step, before anything is built, and fails naming the missing secret and what it costs. `check --live` runs immediately before `wrangler deploy`, adding a comparison against the deployed Worker's own secret list, and `write-secrets-file` then writes the JSON that `--secrets-file` consumes — so the list that is checked and the list that is deployed are the same list.

Two facts make this necessary. `wrangler deploy --secrets-file` **replaces the Worker's whole secret set**, so a secret set by hand with `wrangler secret put`, and not named in the manifest and in the deploy step's `env:` block, is deleted by the next release. And a secret the code requires but production never had fails silently at the feature, not at the deploy: `APPLET_VIEWER_SECRET` was set in every test environment and in none of production, so every published Applet answered 503 from the day the Applet authority shipped until 2026-09-05.

Adding a setting to the Worker's `Env` interface without classifying it in the manifest fails `apps/cloudflare/src/production-secrets.test.ts`, which also checks that the deploy step's `env:` block carries every deployed name and that the check runs before the deploy.

PRs outside `.github/workflows/` queue themselves after checks pass. A PR editing workflow files cannot be queued by `GITHUB_TOKEN` and must be merged by an authorized human identity. Preserve that operational restriction when changing workflow tooling.
