# Cursor cloud-agent creation options

Checked against Cursor's official documentation on 2026-09-22. This is a documentation assessment: no agents were launched, credentials inspected, dependencies installed, or remote state changed.

## Terminal entry point

The documented CLI handoff is an **interactive message beginning with `&`**. Start `agent`, then enter the message in its conversation. Cursor hands that conversation to a Cloud Agent, which can subsequently be followed through [Cursor Agents](https://cursor.com/agents). The docs do not establish that `agent -p '& ...'` performs the same handoff. [CLI overview](https://cursor.com/docs/cli/overview#cloud-agent-handoff)

The current parameter reference lists no `--cloud` flag or cloud-create subcommand. It does list `--model`, `--workspace`, `--mode`, `--print`, output formats, local worktree options, and `agent models`. These should not be assumed to expose every cloud launch control. `agent worker start` connects a machine as an execution worker; it is a different operation from dispatching work to Cursor's hosted VMs. [CLI parameters](https://cursor.com/docs/cli/reference/parameters)

## Authentication

For the CLI, use `agent login` for browser authentication; `agent status` checks the result. Scripts can supply `CURSOR_API_KEY` or `--api-key`. [CLI authentication](https://cursor.com/docs/cli/reference/authentication)

The Cloud Agents REST API accepts a user or service-account API key through Basic authentication (key as username, empty password) or Bearer authentication. Retrieve keys through Cursor's dashboard; a local CLI login should not be treated as proof that a script has an API key. [API authentication](https://cursor.com/docs/api#authentication), [SDK authentication](https://cursor.com/docs/sdk/typescript#authentication)

## REST v1 launch controls

`POST /v1/agents` creates an agent plus its initial run. The current API is public beta. [v1 reference](https://cursor.com/docs/cloud-agent/api/endpoints)

| Choice         | Request fields                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Task           | Required `prompt.text`; optional `prompt.images`: up to five PNG/JPEG/GIF/WebP images, 15 MB each, URL or base64 plus MIME type.                                   |
| Model          | `model.id`, optional `model.params`; discover combinations through `GET /v1/models`. Omission resolves user, team, then system defaults.                           |
| Starting state | `repos[].url`, `startingRef` (branch/SHA), or `prUrl` (overrides ref; URL still required).                                                                         |
| Output         | `workOnCurrentBranch` defaults false: new `cursor/...` branch. True writes the starting branch/PR head. `autoCreatePR`, `skipReviewerRequest` control PR creation. |
| Other          | `name`, `env`, `envVars`, `mcpServers`, `customSubagents`, `mode` (`agent`/`plan`), `agentId`.                                                                     |

`envVars` rollout can silently ignore values; verify before relying on them. A caller-provided `agentId` cannot accompany `envVars`. [Create reference](https://cursor.com/docs/cloud-agent/api/endpoints#create-an-agent)

Follow-ups: `POST /v1/agents/{id}/runs`; one active run per agent. Read/stream individual runs for completion, result and branches. Agent `IDLE` alone does not prove success. Artifacts have list/download endpoints; downloads return temporary URLs. [Run and artifact reference](https://cursor.com/docs/cloud-agent/api/endpoints)

## SDK and older examples

The TypeScript SDK offers `Agent.create({ cloud: ... })`, then `agent.send()`, `run.stream()`/`run.wait()`, follow-ups and artifact download methods. It also documents model discovery and per-run model overrides. [TypeScript SDK](https://cursor.com/docs/sdk/typescript)

Cloud configuration can name an environment or provide up to 20 repositories. A repository-free agent uses `cloud: { repos: [] }`; account/team enablement and a user or unrestricted service-account key are required. SDK cloud options additionally document `openAsCursorGithubApp` and `metadata`. These are SDK-documented controls; the REST create page does not enumerate them. [Cloud options](https://cursor.com/docs/sdk/typescript#cloud), [No-repo agents](https://cursor.com/docs/sdk/typescript#no-repo-cloud-agents)

Older v0 examples use a string `model`, `source.repository/ref/prUrl`, and `target.autoCreatePr` (different capitalization), `branchName`, `openAsCursorGithubApp`, `skipReviewerRequest`, and `autoBranch`. They also support webhooks and `/followup`. Do not copy that request shape into v1; notably, the v1 reference does not expose a custom output `branchName`. [Legacy v0 reference](https://cursor.com/docs/cloud-agent/api/v0)

## Recommended hello-world

After authentication, use the documented interactive CLI handoff with this bounded prompt:

```text
& Hello world. Confirm the repository and checked-out commit, then reply with exactly what you inspected. Do not edit files, install dependencies, commit, push, open a PR, or deploy.
```

This exercises the desired CLI-to-cloud path with a readily checkable result. Before subsequent coding work, choose the model from the authenticated catalog and specify the intended repository/ref and publication behavior. For repeatable dispatch with explicit parameters and machine-readable completion, prefer REST v1 or the SDK.
