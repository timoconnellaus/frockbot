# When it goes wrong

| What you see                                | What it means                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `the build failed at the typecheck stage`   | fix every `path:line:col` line it returned before doing anything else                                                                            |
| `the build failed at the lint stage`        | a rule in `lint.md` was broken; the message names which                                                                                          |
| `the build failed at the describe stage`    | your server threw while booting, so its tools could not be read                                                                                  |
| `the build failed at the bundle stage`      | your code could not be bundled, usually an import that does not resolve; but a message about the Workers runtime not starting is nothing you did |
| `<appletId> has no source`                  | you are publishing an Applet you never scaffolded; call `applet_create`                                                                          |
| `the build service is unavailable`          | nothing you did; say so to the User rather than retrying in a loop                                                                               |
| a publish reports `failed` with diagnostics | the generation did not mount; the previous one is still live and its data is untouched                                                           |
| the tools do not appear                     | a published generation activates on your **next** Turn, not the one that published it                                                            |
| `only the Bot that owns it can change it`   | the Applet is shared with you; ask its owner with `bot_message`                                                                                  |
| `Applet "…" is unavailable`                 | it was deleted, unshared from you, or its owner Bot is archived                                                                                  |

Report a publish failure to the User with the diagnostics as they were
printed. Never claim an Applet is working because the build passed: publishing
is what makes it real, and only a `published` result means it did.
