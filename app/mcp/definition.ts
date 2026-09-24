import type { PackageDefinitionV1 } from "@frockbot/core/contracts";

export const MCP_PACKAGE_ID = "mcp";
export const MCP_CONNECTION_TYPE_ID = "mcp-server";
export const MCP_CAPABILITY_ID = "mcp-tools";
/** The Connection setting holding the server's address. */
export const MCP_URL_SETTING = "url";

/**
 * A remote MCP server a person adds by its address. Each server is one
 * Connection, and its tools are one Tool Namespace on every Bot the person
 * owns, as a connected app's are.
 *
 * The declared authorization is `api-key` because the one secret a server
 * can carry here is a token the person types. It is optional: a server that
 * asks for none is held with no credential at all, and its Connection says
 * `none`.
 */
export const mcpDefinitionV1: PackageDefinitionV1 = {
  id: MCP_PACKAGE_ID,
  displayName: "MCP servers",
  capabilities: [
    {
      id: MCP_CAPABILITY_ID,
      kind: "tool",
      connectionTypes: [MCP_CONNECTION_TYPE_ID],
      admission: {
        turnTypes: ["chat", "agent", "automation", "subagent"],
        subagentRoles: ["executor"],
      },
    },
  ],
  connectionTypes: [
    {
      id: MCP_CONNECTION_TYPE_ID,
      displayName: "MCP server",
      description:
        "Add any remote MCP server by its address. Its tools become your Bots' tools.",
      allowMultiple: true,
      authorization: { kind: "api-key" },
      capabilities: [MCP_CAPABILITY_ID],
      settings: [
        {
          id: MCP_URL_SETTING,
          schemaVersion: 1,
          scopes: ["connection"],
          schema: {
            type: "string",
            title: "Server address",
            description:
              "The server's https address, such as https://mcp.example.com/mcp.",
            maxLength: 2048,
          },
        },
      ],
    },
  ],
  dependencies: ["settings"],
};
