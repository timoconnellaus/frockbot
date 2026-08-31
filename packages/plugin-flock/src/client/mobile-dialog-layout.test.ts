import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generate, parse, walk, type CssNode } from "css-tree";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function isMobileMedia(node: CssNode): boolean {
  return (
    node.type === "Atrule" &&
    node.name === "media" &&
    Boolean(node.prelude) &&
    generate(node.prelude!) === "(max-width:600px)"
  );
}

function isDialogRule(node: CssNode): boolean {
  return node.type === "Rule" && generate(node.prelude) === ".flock-dialog";
}

function mobileDialogHeight(ast: CssNode): string | undefined {
  let mobileMediaDepth = 0;
  let inDialogRule = false;
  let height: string | undefined;
  walk(ast, {
    enter(node: CssNode) {
      if (isMobileMedia(node)) mobileMediaDepth += 1;
      if (mobileMediaDepth > 0 && isDialogRule(node)) {
        inDialogRule = true;
      }
      if (
        inDialogRule &&
        node.type === "Declaration" &&
        node.property === "height"
      ) {
        height = generate(node.value);
      }
    },
    leave(node: CssNode) {
      if (mobileMediaDepth > 0 && isDialogRule(node)) inDialogRule = false;
      if (isMobileMedia(node)) mobileMediaDepth -= 1;
    },
  });
  return height;
}

describe("mobile Flock dialog layout", () => {
  test("tracks the dynamic viewport so the Create Bot action remains reachable", () => {
    expect(mobileDialogHeight(parse(styles))).toBe("calc(100dvh - 20px)");
  });
});
