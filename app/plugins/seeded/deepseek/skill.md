---
name: deepseek
description: How this Bot's DeepSeek provider plugin works, and what it needs to run.
---

# DeepSeek provider

This plugin serves the **DeepSeek** model provider. It is the model protocol:
it turns the kernel's normalized request into DeepSeek's chat-completions
wire and DeepSeek's stream back into normalized events. It has no tools and
no hooks — selecting a DeepSeek model is the only thing that runs it.

## What it needs

- A **DeepSeek Connection**: an API key, held by the deployment.
- A Bot whose model is a DeepSeek model. Selecting that model is what runs
  this plugin; the plugin page's switch does not change it.

## What it can reach

Nothing by itself. The key never reaches this plugin: every model request it
is asked for becomes one upstream call, made by the host to the single
destination and route this deployment allows — `/chat/completions` — with the
key attached server-side and the response streamed back. The plugin composes a
request body and names nothing else: it neither picks the destination nor
writes the path.

## When a reply fails

A refused key or an unknown model is reported to the kernel as a permanent
provider failure: it is not retried. A failed upstream (HTTP 5xx) is not a
refusal — the request reached the provider, which may have accepted and
billed it — so it is reported as an uncertain outcome: the host records an
estimate and settles the reply rather than sending the request again. A rate
limit (HTTP 429) is refused as transient, but one request id is one upstream
call, so the retry the kernel may plan for it is never sent either. If the
plugin itself fails, the reply fails with it — a model call is never silently
skipped.
