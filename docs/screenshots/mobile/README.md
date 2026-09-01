# The phone layout, as it renders

These are captured, not composed: every image is a frame from
`apps/cloudflare/e2e/mobile.e2e.ts` running the production serving path — the
real client bundle, seeded into R2 and served by `src/index.ts` under
`wrangler dev` — at a 390×844 viewport.

Regenerate them with:

```sh
cd apps/cloudflare && bunx playwright test -c e2e/playwright.config.ts mobile.e2e.ts
```

They land in `e2e/test-results/mobile/`. The spec, not this directory, is the
thing that holds the layout to account; these are here so a reader can see what
it asserted without running it.

| Frame                   | What it shows                                             |
| ----------------------- | --------------------------------------------------------- |
| `01-first-run-dialog`   | The Bot creation dialog a first-run User meets            |
| `02-navigation-drawer`  | The Bot list as a drawer, over a dimmed conversation      |
| `03-models-surface`     | A hosted surface at full width                            |
| `04-empty-thread`       | One column: topbar, conversation, composer                |
| `05-conversation`       | A Turn, with the drawer closed behind the Bot that opened |
| `06-right-panel`        | The right panel as the trailing drawer, full width        |
| `07-bot-settings-panel` | A panel-placed surface taking the whole window            |
