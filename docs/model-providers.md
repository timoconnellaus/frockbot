# Model provider connections

FrockBot ships 28 provider entries. Every one takes an API key, and three also offer OAuth sign-in. They come from DeepSeek Harness’s pinned `@earendil-works/pi-ai` 0.85.1 catalog, less the [excluded providers](#excluded-providers). Regional API-key endpoints are separate connections. Frock AI remains the zero-configuration default, Ollama Cloud remains available, and [Local models](#local-models) run on the person's own Mac.

Choose a provider on Setup's AI page (`/setup/ai`): the picker searches every provider the product supports, grouped as FrockBot, Popular, All providers and Your own. A provider not yet on the account is added as its Connect dialog opens; connect its API key, or choose **Sign in** where the provider offers one, then pick its model for chat. **Your accounts** replaces or removes a key. Frock AI is built in and needs no key. Connections belong to the User and are available to every Bot they own. Keys are encrypted server-side and never shown again. Saving a catalog-provider key does not run a paid inference probe; invalid credentials are reported when a Turn first uses them, and Setup shows the job whose provider failed. Radius reads its authenticated catalog when connecting.

DeepSeek is served by an installed Plugin rather than a compiled adapter ([ADR 0032](adr/0032-plugin-model-providers.md)). It appears in Setup's provider list like every other model, and nowhere as a Plugin: connecting it installs the Package (and the Plugin artifact), then adds the API key. Installation is account-wide but does not choose a model or create a credential. The key is an ordinary account Connection held server-side, and the Plugin never sees it. Uninstalling the Package returns a Bot that was using it to the platform default (Frock AI); the model line reports the chosen model as unavailable. Everything else in the catalog keeps its compiled adapter.

## Included providers

- Amazon Bedrock (`amazon-bedrock`)
- Ant Ling (`ant-ling`)
- Anthropic (`anthropic`)
- Azure OpenAI (`azure-openai-responses`)
- Baseten (`baseten`)
- Cerebras (`cerebras`)
- Cloudflare AI Gateway (`cloudflare-ai-gateway`)
- Cloudflare Workers AI (`cloudflare-workers-ai`)
- DeepSeek (`deepseek`)
- Fireworks (`fireworks`)
- Google (`google`)
- Google Vertex AI (`google-vertex`)
- Groq (`groq`)
- Hugging Face (`huggingface`)
- MiniMax (`minimax`)
- MiniMax CN (`minimax-cn`)
- Mistral (`mistral`)
- Moonshot AI (`moonshotai`)
- Moonshot AI CN (`moonshotai-cn`)
- NVIDIA (`nvidia`)
- OpenAI (`openai`)
- OpenCode Zen (`opencode`)
- OpenRouter (`openrouter`)
- Radius (`radius`)
- Together (`together`)
- Vercel AI Gateway (`vercel-ai-gateway`)
- xAI (`xai`)
- Xiaomi (`xiaomi`)

## Provider-specific setup

- **Azure OpenAI:** supply the resource API base URL; an API version override is optional. Model IDs must match the deployments available at that endpoint.
- **Amazon Bedrock:** supply a Bedrock bearer API token and optionally a region (default `us-east-1`) or endpoint. FrockBot uses the fetch-based Converse API. It does not read deployment-wide AWS profiles or IAM credentials.
- **Cloudflare Workers AI:** supply an API token and account ID, or a complete compatible endpoint.
- **Cloudflare AI Gateway:** supply the account ID and gateway ID with the API token.
- **Google Vertex AI:** use a Google Cloud API key. Local application-default credential files are not read by the hosted product.

The model picker initially shows up to 90 catalog models per connection. Exact model resolution can select other models in the installed catalog. A custom endpoint override keeps that provider’s catalog and protocol choices; it does not discover arbitrary new gateway models.

## Local models

**Local models** (`provider-local`, provider type `local`) reach an OpenAI-compatible model server on the person's Mac: Ollama (`http://localhost:11434/v1`), LM Studio (`http://localhost:1234/v1`), [mesh-llm](https://github.com/Mesh-LLM/mesh-llm) (`http://localhost:9337/v1`), or any other localhost port. There is no key. A Connection names a paired Mac (`machine-id`) and the endpoint on it (`endpoint`), and it is added from the Marketplace like any model: choose the Mac, choose the server, and **Test and connect**. Connecting asks the server for its `/v1/models` through the Mac, so the account comes back ready with its models or failed with the reason (the Mac is offline, nothing is answering on that port, the server has no models yet). **Refresh models** asks again.

The cloud never dials the Mac. The Mac app's device host already holds the machine socket to the User Durable Object, so a model call is sent down that socket as a `relay` frame and the model server's streamed answer comes back up it (`core/machine-protocol/relay.ts`, `app/machine/model-relay.ts`, `apps/device-host/src/relay.ts`). The Bot names only the Connection; the User Durable Object reads the Mac and the endpoint from it and composes the one URL. Only `localhost`, `127.0.0.1` and `[::1]` are ever relayed: the cloud refuses to send anything else, the device host checks again and refuses redirects, and the host's own Deno permissions admit only those hosts beside the deployment. The relay carries the model call's request id as its relay id, and the device host forwards a relay id once.

A Connection stays ready while its Mac sleeps. A Turn on a local model whose Mac is not connected fails with "Your Mac is offline, so your local model can't answer." and one whose Mac drops mid-answer with "Your Mac went offline before your local model finished answering." Neither ever falls back to Frock AI. A local model is free: its calls are recorded on Spending at no charge and are never refused for want of credit, a plan or a daily limit. The first byte may take up to two minutes while the server loads a model. Structured output uses the kernel's prompt fallback.

## OAuth sign-in

Sign-in is available for **OpenRouter, xAI, and Radius**. Existing API-key connections are independent and can coexist with signed-in accounts.

A provider that takes a key or a sign-in is one row in Setup's provider list; its Connect dialog offers both ways, the key and **Sign in**. Choose **Sign in** and a short-lived FrockBot sign-in page opens. For device-code providers, open the provider link and enter the displayed code. FrockBot finishes the connection in the background. OpenRouter uses PKCE: after authorizing, copy the return URL into the sign-in form and choose **Finish connecting**. The return address is set by FrockBot's HTTPS gateway.

A page refresh resumes a pending attempt. Closing the page does not cancel it; use **Cancel sign-in** to cancel. Pending device authorization is checked by the User's durable alarm. Sign-in attempts expire, are account-bound, and keep device codes, PKCE verifiers, and tokens encrypted. A mobile browser link grants only access to that attempt and expires with it. It never carries provider access or refresh tokens.

Access tokens refresh server-side before a new model request when near expiry. Refresh is serialized across Bots sharing the connection. An interrupted exchange or refresh is not retried blindly because its token may already have been consumed: the connection asks the User to sign in again. Connect again, select the new connection for the Bot, and remove the failed connection. Disconnect removes the local credential; revoke access in the provider's account settings as well when needed. OpenRouter returns a permanent, user-revocable API key through its OAuth flow, so that connection does not need token refresh.

Radius sign-in targets `radius.pi.dev`. Account entitlement and device-login availability are determined by the provider.

## Excluded providers

Consumer subscriptions and coding plans are left out when the provider's terms forbid a hosted, general-purpose or unattended client, or when the adapter would present itself as another client. The list lives in `providers/catalog/generate.ts`, so a dependency update does not bring them back.

- **Claude subscription sign-in:** Anthropic disallows third-party applications offering Claude.ai login on behalf of users. Anthropic API keys remain available. See [Anthropic's authentication rules](https://code.claude.com/docs/en/legal-and-compliance).
- **OpenAI Codex** (`openai-codex`): ChatGPT sign-in is approved for OpenAI's clients, pure open-source clients and OpenAI's partners, not hosted agents. OpenAI API keys remain available.
- **GitHub Copilot** (`github-copilot`): the adapter presents itself to GitHub as VS Code and signs in with GitHub's own client.
- **Kimi For Coding** (`kimi-coding`): Kimi Code is for interactive use in coding agents and may not be resold as a service. Moonshot AI API keys remain available.
- **Z.AI** (`zai`, `zai-coding-cn`): both entries use the GLM Coding Plan, which may not be used from bots or SaaS products.
- **Qwen Token Plan** (`qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`): not for application backends or scheduled tasks.
- **Xiaomi Token Plan** (`xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`): only for programming tools, not application backends. Xiaomi API keys remain available.
- **OpenCode Go** (`opencode-go`): a subscription for OpenCode and other coding agents. OpenCode Zen remains available.

## Runtime guarantees

Provider requests receive the durable request ID as an idempotency header and have SDK retries disabled. A header is not a guarantee that a vendor deduplicates requests: uncertain network failures are not classified as safe-to-retry rejections. Credential settlement follows the committed model outcome. A Plugin-served provider admits one upstream call per request ID: once the request has left, an answer that is lost or never confirmed stops the Turn with the estimated usage recorded and is never dispatched again, so sending the message again is a new request rather than a retry of the same one.

Tool calls are released only after a successful terminal response. Signed response content needed by Gemini and other providers is preserved in the durable assistant event and replayed only to the same provider, model, Connection, and credential generation. It is not rendered as assistant text. Partial streams without a terminal event fail explicitly. Structured output uses the existing prompt fallback and FrockBot validation.

The catalog is generated from the dependency’s built-in provider definitions, rather than fetched from a public catalog during a Turn. To update it, change the pinned dependency, run `bun providers/catalog/generate.ts`, format the generated files, and validate the provider tests and Worker integration suite.

Reference inspected: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/llm/llm-pi-ai). Model catalogs and protocol compatibility details come from the installed MIT-licensed pi-ai dependency.
