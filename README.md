# FrockBot

FrockBot is an experimental desktop host for [Pi](https://pi.dev). It starts with one bare bot and is designed to grow through packages that can add agent capabilities and desktop UI.

This repository currently contains the first vertical slice:

- a sandboxed Electron renderer;
- a narrow, typed preload bridge;
- a separate Pi SDK utility process;
- streamed assistant text and tool activity;
- prompt cancellation and worker restart handling;
- a Bun workspace with unit tests and production builds.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- a Pi-supported model configured through `~/.pi/agent` or the corresponding provider environment variable

## Development

```bash
bun install
bun run dev
```

Electron's installer script is explicitly allowed through the root `trustedDependencies` setting. If Electron was installed before that setting existed, rebuild its binary once:

```bash
node apps/desktop/node_modules/electron/install.js
```

## Checks

```bash
bun run typecheck
bun test
bun run build
```

The desktop smoke path can capture the connected UI without a model call:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot.png" \
  bun run --filter @frockbot/desktop start
```

To exercise one real streamed Pi turn as well:

```bash
FROCKBOT_SMOKE_SCREENSHOT="$PWD/artifacts/frockbot-chat.png" \
FROCKBOT_SMOKE_PROMPT='Reply with exactly: FrockBot is ready.' \
  bun run --filter @frockbot/desktop start
```

## Structure

```text
apps/
  desktop/          Electron main process, preload bridge, and React renderer
  agent-worker/     Pi SDK worker built into a separate Node entry
packages/
  protocol/         Commands and events shared across process seams
docs/research/      Architecture research and source notes
```

## Security model

The renderer uses `nodeIntegration: false`, context isolation, Chromium sandboxing, a restrictive content security policy, and a small preload interface. Pi runs outside the renderer in a utility process.

The utility-process split provides crash containment, not a security sandbox. Future chat-generated executable plugins must run inside a bot container or micro-VM rather than in Electron's main process.

## Current limitations

- sessions are in memory;
- model onboarding and selection use existing Pi configuration;
- the computer and routines panel is presentational;
- bot creation, search, plugins, and context-menu commands are not implemented yet;
- application packaging and code signing are not configured.
