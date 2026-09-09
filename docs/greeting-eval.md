# Greeting eval

Run `bun run eval:greeting` from the repository root. This makes ten real
Ollama requests in fresh conversations (more if the model needs delivery repair).
The default model is `glm-5.3-flash:cloud` on `https://ollama.com`.
Set `OLLAMA_API_KEY` in your environment or the gitignored
`.dev.vars` at the main repository root. Linked worktrees locate that shared file
through Git, so deleting a worktree does not delete the key. Existing environment
variables take precedence. For another Ollama server, set `OLLAMA_BASE_URL`
to its root URL; `OLLAMA_MODEL` overrides the exact model identifier.

The eval mounts the production base runtime packages, including identity and
the Shell's conversation prompt, and uses the real agent loop and shared
OpenAI-compatible transport used by Ollama. It represents a fresh base Bot,
without account-specific instructions, skills, or connected tools.

Each run sends `Hi`. Passing requires one model call, exactly one tool call
(`send_to_user` with `disposition: finish`), one nonempty text greeting no longer
than 240 characters, and a completed Turn. A delivery-repair call fails the
eval even if a greeting eventually arrives. Greeting vocabulary is a small
English heuristic; inspect the actual responses as well.

All ten runs must pass. The command exits nonzero on failure and writes
requests, events, replies, elapsed time, model, commit and working-tree state
to `.eval-results/`. These traces are gitignored and contain no API key.
The model's default sampling settings are used; ten passes are a smoke check,
not a statistical reliability claim. Results from a dirty checkout are exploratory
and are not pre-push validation receipts. This live eval is explicitly invoked,
not included in ordinary tests or the pre-push gate.
