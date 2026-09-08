# Local development

Smoke-test a change here, not in production. One command brings up the whole
product on this machine with the phone app running against it on an Android
emulator you are signed in to.

```
bun run dev:native      # build, seed, serve, boot the emulator, install the app
bun run smoke:native    # sign in, send a message, expect a reply
bun scripts/native-dev.ts down
```

## What runs

| Piece         | How                                                                                                                        | Parity with production                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| App Worker    | `wrangler dev --env development` on `:8797`                                                                                | Same workerd. Local R2, D1 and Durable Objects under `.native-dev/`; the remote AI, Vectorize and memory bindings when wrangler is signed in. |
| Computer host | its own `wrangler dev` on `:8799`, when `SPRITES_TOKEN` is set                                                             | Real Sprites. The first start builds the container image with Docker.                                                                         |
| Model         | Ollama Cloud when `OLLAMA_API_KEY` is set; otherwise the platform model over the remote AI binding                         | The same providers production runs. The remote binding costs real Workers AI money per token; Ollama is the default for routine work.         |
| App           | debug APK on the emulator, pointed at `http://127.0.0.1:8797` — the host's loopback, lent to the emulator by `adb reverse` | Same code, same wire protocol.                                                                                                                |
| Sign-in       | the Worker's development door, as the `development` User                                                                   | **The one departure.** No Google. Production refuses `ALLOW_DEVELOPMENT_AUTH`.                                                                |

The `development` User is an admin, has a Bot called "Dev Bot", and can also
open the web client at `http://127.0.0.1:8797/?as_user=development`.

## Secrets

`apps/cloudflare/.dev.vars` (gitignored; copied from `~/repos/grokbot-headless`
if missing) needs `CREDENTIAL_KEYRING`. Optional:

- `OLLAMA_API_KEY` — seeds an Ollama Cloud connection and sets it as the
  account model. Without it, connect a model in Settings.
- `SPRITES_TOKEN` — turns the Computer on. `COMPUTER_HOST_TOKEN` is minted the
  first time and written to both Workers' `.dev.vars`.

## The development sign-in door

A debug build carries `--dart-define=FROCKBOT_ORIGIN=…` and
`--dart-define=FROCKBOT_DEV_AUTH=true`. It starts the real native sign-in
(`/api/auth/native/start`), the Worker's `/native/authorize` issues the code for
the `development` User instead of bouncing to Google, and the app receives it on
`frockbot-dev://native/return/android` — a custom scheme, because a plain-HTTP
loopback origin can never be an App Link. The exchange, the bearer
and the session are production's. The scheme is declared in the debug manifest
only, so a release build cannot receive it.

The Worker lists that return URI, and answers on `BETTER_AUTH_URL` rather than
the production origin, only when `ALLOW_DEVELOPMENT_AUTH` is set — a variable
`scripts/check-production-secrets.ts` refuses in production.

## Iterating

- Hot reload: `adb reverse tcp:8797 tcp:8797 && cd apps/native && flutter run -d <emulator> --dart-define=FROCKBOT_ORIGIN=http://127.0.0.1:8797 --dart-define=FROCKBOT_DEV_AUTH=true`
- Worker code reloads on save under `wrangler dev`; `bun scripts/native-dev.ts serve` restarts the Workers without rebuilding, `app` rebuilds and reinstalls the app alone.
- The emulator loses its `adb reverse` on reboot; `up`, `app` and `smoke` all reapply it.
- Logs: `.native-dev/logs/` (or `$CLAUDE_JOB_DIR/tmp/native-dev/` in a job).
- Fresh state: `down`, delete `.native-dev/`, `up`.

`smoke:native` passes only when the reply appears in the native transcript. A completed Turn with no `send_to_user` event fails the smoke check.

`smoke:native` completes the browser leg itself — the debug build logs the
authorization URL it opens, the smoke makes that request and delivers the
return to the app — so a fresh emulator's Chrome first-run screens never gate
it. Tapping "Continue as local developer" by hand goes through Chrome for real.
