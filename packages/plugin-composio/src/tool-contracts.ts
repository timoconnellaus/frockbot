/** Versioned, credential-free projection shared by the User owner and Bot runtime. */
export interface ConnectedToolV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version: string;
}
export interface ConnectedToolsV1 {
  schemaVersion: 1;
  namespace: string;
  label: string;
  tools: ConnectedToolV1[];
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function decodeConnectedToolsV1(value: unknown): ConnectedToolsV1 {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.namespace !== "string" ||
    !/^[a-z][a-z0-9_-]{0,199}$/.test(value.namespace) ||
    typeof value.label !== "string" ||
    value.label.length > 240 ||
    !Array.isArray(value.tools) ||
    value.tools.length > 1000
  )
    throw new Error("Connected tools are unavailable");
  const names = new Set<string>();
  const tools = value.tools.map((tool) => {
    if (
      !object(tool) ||
      typeof tool.name !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,199}$/.test(tool.name) ||
      names.has(tool.name) ||
      typeof tool.description !== "string" ||
      tool.description.length > 32_768 ||
      !object(tool.inputSchema) ||
      tool.inputSchema.type !== "object" ||
      typeof tool.version !== "string" ||
      !/^[0-9]{8}_[0-9]+$/.test(tool.version)
    )
      throw new Error("Connected tool definition is invalid");
    names.add(tool.name);
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      version: tool.version,
    };
  });
  return {
    schemaVersion: 1,
    namespace: value.namespace,
    label: value.label,
    tools,
  };
}
