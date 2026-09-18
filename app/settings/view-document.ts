import type { ViewNode } from "@frockbot/core/protocol-schemas";

export function countViewNodesV1(node: ViewNode): number {
  if (node.type === "group") {
    return (
      1 +
      node.children.reduce((total, child) => total + countViewNodesV1(child), 0)
    );
  }
  if (node.type === "list") {
    return (
      1 +
      node.rows.reduce((total, row) => total + countViewNodesV1(row.node), 0)
    );
  }
  return 1;
}
