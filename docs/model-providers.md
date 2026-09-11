# Model provider connections

FrockBot ships 40 provider entries: 39 with API-key support and six with OAuth sign-in, including OAuth-only OpenAI Codex. They come from DeepSeek Harness’s pinned `@earendil-works/pi-ai` 0.85.1 catalog. Regional and subscription API-key endpoints are separate connections. Frock AI remains the zero-configuration default, and Ollama Cloud remains available.

Enable a provider in Settings, connect its API key or choose **Sign in**, then select one of its models. Connections belong to the User and are available to every Bot they own. Keys are encrypted server-side. Saving a catalog-provider key does not run a paid inference probe; invalid credentials are reported when a Turn first uses them. Radius reads its authenticated catalog when connecting.

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
- GitHub Copilot (`github-copilot`)
- Google (`google`)
- Google Vertex AI (`google-vertex`)
- Groq (`groq`)
- Hugging Face (`huggingface`)
- Kimi For Coding (`kimi-coding`)
- MiniMax (`minimax`)
- MiniMax CN (`minimax-cn`)
- Mistral (`mistral`)
- Moonshot AI (`moonshotai`)
- Moonshot AI CN (`moonshotai-cn`)
- NVIDIA (`nvidia`)
- OpenAI (`openai`)
- OpenAI Codex (`openai-codex`, OAuth only)
- OpenCode Zen (`opencode`)
- OpenCode Go (`opencode-go`)
- OpenRouter (`openrouter`)
- Qwen Token Plan (`qwen-token-plan`)
- Qwen Token Plan CN (`qwen-token-plan-cn`)
- Qwen Token Plan Individual (`qwen-token-plan-individual`)
- Radius (`radius`)
- Together (`together`)
- Vercel AI Gateway (`vercel-ai-gateway`)
- xAI (`xai`)
- Xiaomi (`xiaomi`)
- Xiaomi Token Plan AMS (`xiaomi-token-plan-ams`)
- Xiaomi Token Plan CN (`xiaomi-token-plan-cn`)
- Xiaomi Token Plan SGP (`xiaomi-token-plan-sgp`)
- Z.AI (`zai`)
- Z.AI Coding CN (`zai-coding-cn`)

## Provider-specific setup

- **Azure OpenAI:** supply the resource API base URL; an API version override is optional. Model IDs must match the deployments available at that endpoint.
- **Amazon Bedrock:** supply a Bedrock bearer API token and optionally a region (default `us-east-1`) or endpoint. FrockBot uses the fetch-based Converse API. It does not read deployment-wide AWS profiles or IAM credentials.
- **Cloudflare Workers AI:** supply an API token and account ID, or a complete compatible endpoint.
- **Cloudflare AI Gateway:** supply the account ID and gateway ID with the API token.
- **Google Vertex AI:** use a Google Cloud API key. Local application-default credential files are not read by the hosted product.
- **GitHub Copilot:** use a Copilot API token; a generic GitHub personal access token is not interchangeable with it.

The model picker initially shows up to 90 catalog models per connection. Exact model resolution can select other models in the installed catalog. A custom endpoint override keeps that provider’s catalog and protocol choices; it does not discover arbitrary new gateway models.

## OAuth sign-in

Sign-in is available for **OpenAI Codex, GitHub Copilot, Kimi Coding, OpenRouter, xAI, and Radius**. Existing API-key connections are independent and can coexist with signed-in accounts.

Choose **Sign in** in the web provider settings. On mobile, use the provider's sign-in connection in Connections; a short-lived FrockBot sign-in page opens. For device-code providers, open the provider link and enter the displayed code. FrockBot finishes the connection in the background. OpenRouter uses PKCE: after authorizing, copy the return URL into the sign-in form and choose **Finish connecting**. The return address is set by FrockBot's HTTPS gateway.

A page refresh resumes a pending attempt. Closing the page does not cancel it; use **Cancel sign-in** to cancel. Pending device authorization is checked by the User's durable alarm. Sign-in attempts expire, are account-bound, and keep device codes, PKCE verifiers, and tokens encrypted. A mobile browser link grants only access to that attempt and expires with it. It never carries provider access or refresh tokens.

Access tokens refresh server-side before a new model request when near expiry. Refresh is serialized across Bots sharing the connection. An interrupted exchange or refresh is not retried blindly because its token may already have been consumed: the connection asks the User to sign in again. Connect again, select the new connection for the Bot, and remove the failed connection. Disconnect removes the local credential; revoke access in the provider's account settings as well when needed. OpenRouter returns a permanent, user-revocable API key through its OAuth flow, so that connection does not need token refresh.

Copilot currently supports github.com accounts, not GitHub Enterprise domains. Radius sign-in targets `radius.pi.dev`. Account entitlement and device-login availability are determined by the provider; Codex device authentication may need enabling in the account's security settings. See [OpenAI authentication](https://developers.openai.com/codex/auth/).

Claude subscription OAuth is excluded because Anthropic disallows third-party applications offering Claude.ai login on behalf of users. Anthropic API-key connections remain available. See [Anthropic's authentication rules](https://code.claude.com/docs/en/legal-and-compliance).

## Runtime guarantees

Provider requests receive the durable request ID as an idempotency header and have SDK retries disabled. A header is not a guarantee that a vendor deduplicates requests: uncertain network failures are not classified as safe-to-retry rejections. Credential settlement follows the committed model outcome.

Tool calls are released only after a successful terminal response. Signed response content needed by Gemini and other providers is preserved in the durable assistant event and replayed only to the same provider, model, Connection, and credential generation. It is not rendered as assistant text. Partial streams without a terminal event fail explicitly. Structured output uses the existing prompt fallback and FrockBot validation.

The catalog is generated from the dependency’s built-in provider definitions, rather than fetched from a public catalog during a Turn. To update it, change the pinned dependency, run `bun providers/catalog/generate.ts`, format the generated files, and validate the provider tests and Worker integration suite.

Reference inspected: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/5dda764ed3aa172535a7967b06ff95d9cbfe536a/packages/llm/llm-pi-ai). Model catalogs and protocol compatibility details come from the installed MIT-licensed pi-ai dependency.
