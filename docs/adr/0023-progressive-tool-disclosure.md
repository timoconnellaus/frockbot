---
status: accepted
---

# Tool schemas are disclosed progressively through a two-tier surface

Accepted by the owner on 2026-09-03.

Sending every registered tool schema with every model request does not scale to account-shaped integrations. A live GrokBot probe exposed 18 namespaces and roughly 370 tools; expanding all of those schemas would add a multi-100KB payload to every request even when a Turn uses none of them. FrockBot also permits the same bare tool name in different connected accounts and Bot-authored Packages, so a single flat name set is not the right identity boundary.

FrockBot mirrors GrokBot's two-tier surface. A small native set remains ordinary model tools. `@frockbot/plugin-tools` always contributes `get_dynamic_tools` and `call_dynamic_tool`; all other progressively disclosed tools declare `namespace` on the kernel's narrow `ToolDefinition`. Namespace description, readiness, external-service status, and use instructions are registered separately. The prompt contains a `<dynamic_tool_catalog>` with namespace and tool names only. Full descriptions and input schemas appear only in the result of `get_dynamic_tools`, and `call_dynamic_tool` invokes the selected descriptor.

The meta-tools and the disclosure policy belong to `plugin-tools`, not the Agent loop. A discovered schema is never promoted into a first-class registered tool, and the host keeps no expanded-tool state. The conversation transcript is the model's cache: discovery results are ordinary tool results, while each exact normalized model request and catalog prompt is already recorded by the Session event log.

One dynamic invocation remains one durable effect. Its outer `call_dynamic_tool` intent is what the Session records, and the inner call reuses that call ID while replacing the name and arguments for the registry's `prepare` → `executePrepared` pipeline. This makes guards, pre-execute, execute, post-execute, and result observers see the actual target without inventing a second durable effect. Preparation and recovery use the inner definition's `idempotent` and reconciliation declarations.

## Considered options

- **Keep sending the flat catalog:** simplest execution path, but request size grows with every connected account and installed Package. Rejected.
- **Promote tools after discovery in host-side state:** can make later calls look native, but creates mutable expanded-tool state that must survive eviction and be reconstructed independently of the transcript. Rejected.
- **Two-tier discovery and invocation:** chosen. Request size is bounded by native tools, two stable meta-tools, and the name-only prompt catalog.

## Consequences

Every dynamic call costs a discovery round-trip before invocation. Catalog and pattern results deliberately trade detail for size; namespace and single-tool lookups return full schemas. A namespace whose status is not ready cannot be called, and external namespaces require descriptive call metadata.

`call_dynamic_tool` is not an execution bypass: it must forward the inner tool's idempotency and traverse every registry hook. Durable history keeps the outer intent, while the hosted client renders `namespace/toolName` and the inner arguments so the activity is intelligible rather than an opaque meta-call. Composio namespaces are stable per connected account, and non-first-party isolate namespaces are their immutable Package IDs.
