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

Nothing by itself. The key never reaches this plugin: its one upstream call
per reply goes through the host, which checks the destination against the
Connection's endpoint, attaches the key server-side and streams the response
back. The plugin names a path — `/chat/completions` — and nothing else.

## When a reply fails

A refused key or an unknown model is reported to the kernel as a permanent
provider failure: it is not retried. A busy provider (HTTP 429) or a failed
upstream (5xx) is transient and the kernel retries it. If the plugin itself
fails, the reply fails with it — a model call is never silently skipped.
