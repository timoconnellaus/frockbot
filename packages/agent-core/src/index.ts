// Re-export barrel over the kernel packages and the registry Packages that
// implement the kernel-declared interfaces. Types and classes only: registering
// a Cordis Service instance here would collide with the owning Package.
export * from "@frockbot/kernel-contracts";
export * from "@frockbot/kernel-agent-loop/agent";
export { ToolRegistry } from "@frockbot/plugin-tools";
export { LlmRegistry } from "@frockbot/plugin-models";
export { SystemPromptRegistry } from "@frockbot/plugin-prompt";
