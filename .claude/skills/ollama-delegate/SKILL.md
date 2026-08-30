---
name: ollama-delegate
description: Delegate a well-scoped, self-contained text task to the local ollama CLI running glm-5.3-flash:cloud, so the main agent's context and turns are spent on judgment rather than volume. Use when the user says "delegate to ollama", "farm this out", "use glm", or when a sub-task is mechanical and fully specifiable up front — summarising or extracting from documents, drafting boilerplate from a spec, generating test-case tables, converting between formats or schemas, first-pass review of a diff for one named concern, rewriting prose. Do not use for tasks needing repository navigation, tool use, or judgment about this codebase.
---

# Ollama delegate

`glm-5.3-flash:cloud` via `ollama run` is a fast, cheap, tool-less model. It sees only the
text it is sent, produces one reply, and stops. Delegation pays off when the task is
**mechanical and fully specifiable**, and costs more than it saves when the model would
need to look something up or decide something about the repo.

## Run

```bash
.claude/skills/ollama-delegate/scripts/delegate.sh -t "TASK" [-c file]... [-o out.md] [--json] [--think low]
.claude/skills/ollama-delegate/scripts/delegate.sh -f task.md -c src/a.ts -c src/b.ts
```

- `-t` / `-f`: the task, inline or from a file. Required.
- `-c`: a file to append to the prompt, fenced and labelled with its path. Repeatable. This is the only way the model sees code or documents.
- `-o`: output path. Defaults to a timestamped file in the scratchpad; the path is printed on stdout.
- `--json`: ask for a JSON reply (`--format json`), for structured extraction.
- `--think low|medium|high`: enable thinking for harder reasoning tasks; default off.
- `OLLAMA_DELEGATE_MODEL` overrides the model.

Read the output file afterwards. The model's reply is never shown to the user directly.

## Scope a task before delegating

A task is well-scoped when every line below is true. If one is false, fix the task or do it yourself.

1. **Self-contained.** Everything the model needs is in `-t` or `-c`. No "look at the surrounding code", no "as we discussed", no repo paths it would have to open.
2. **One deliverable.** Name exactly what comes back: "a Markdown table with columns X, Y, Z", "TypeScript only, no prose", "a list of at most 10 findings, each with file and line".
3. **Verifiable.** State how the result will be checked, and check it that way. Delegated code goes through `bun run typecheck` and the tests; delegated facts get spot-checked against the source.
4. **Bounded input.** Send the files the task needs, not the directory. Trim large files to the relevant region with `sed -n` into a temp file and pass that.
5. **No repo judgment.** Nothing about FrockBot's constitution, architecture, or conventions unless the relevant text is pasted in as context.

## Write the task

Put the format contract first, then the task, then constraints. Example:

```
Reply with only a Markdown table: | case | input | expected | notes |.
Write the boundary and error test cases for the function `decodeManifest` in the file
below. Cover: empty input, unknown fields, nesting over 8 levels, oversized schema.
Do not write test code. Do not explain.
```

Then `-c packages/plugin-catalog/src/manifest.ts`.

## Use the result

- Treat the reply as untrusted input: read it, check it, and integrate it yourself. Never paste it into the codebase unread.
- If it is wrong in a way more context would fix, re-run with the missing context rather than correcting it by hand.
- If it is wrong in a way that needs repo judgment, stop delegating that task.
- Cite the delegation in your reply to the user when it materially shaped the work.

## Good and bad delegations

| Good                                                    | Bad                                              |
| ------------------------------------------------------- | ------------------------------------------------ |
| Summarise a 400-line research note into 10 bullets      | Decide whether that note contradicts `AGENTS.md` |
| Draft a Zod schema from a pasted JSON sample            | Find where in the repo the schema should live    |
| List test cases for one pasted function                 | Write and run the tests                          |
| First-pass review of a pasted diff for unhandled errors | Judge whether the diff matches the spec          |
| Convert a pasted table to JSON                          | Anything that needs `git`, `grep`, or a browser  |
