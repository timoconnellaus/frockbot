# When it goes wrong

| What you see                                               | What it means                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `path:line:col` from `plugin_check`                        | fix every line before publishing                                                                                 |
| `the build failed at the typecheck stage`                  | the module does not type-check against `@frockbot/applet-sdk/plugin`                                             |
| `the build failed at the describe stage`                   | the module threw while booting, so its exports could not be read                                                 |
| `the build failed at the bundle stage`                     | usually a value import; only `import type` from the SDK is allowed                                               |
| `plugin.json declares tools […] but plugin.ts exports […]` | the two files disagree; the same wording exists for hooks, services, triggers, views, cards and model providers  |
| `contractVersion is not a known contract`                  | you typed a number the scaffold did not; put back the one `plugin_create` wrote                                  |
| a provider claim fails to mount                            | this Plugin id is not the artifact the deployment catalog names for that provider                                |
| an unmet `consumes`                                        | that Plugin alone is disabled; satisfy the service or drop the consume                                           |
| `the build service is unavailable`                         | nothing you did; tell the User rather than retrying in a loop                                                    |
| a publish reports diagnostics                              | nothing was stored and no approval card was sent                                                                 |
| the Plugin does not run                                    | it is live from the **next** Turn after the User approves, not this one; sibling Bots still need `plugin_enable` |
| three failures and it is off                               | a hook, press or draw threw or overran; a person switches it on again                                            |
| `ctx.schedule` is unavailable                              | you are outside a Turn (section, control, trigger)                                                               |
| `fetch` is refused                                         | the host is not in `network.hosts` and `open` is not true                                                        |
| `email` is unavailable                                     | this deployment has bound no sender, or you named the wrong approval                                             |

Report a publish failure to the User with the diagnostics as they were
printed. Never claim the Plugin is live because the check passed: the
User's approval is what makes it run.
