import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const mobileStyles = styles.slice(styles.indexOf("@media (max-width: 600px)"));

describe("mobile Flock dialog layout", () => {
  test("tracks the dynamic viewport so the Create Bot action remains reachable", () => {
    expect(mobileStyles).toContain("height: calc(100dvh - 20px);");
    expect(mobileStyles).not.toContain("height: calc(100vh - 20px);");
  });
});
