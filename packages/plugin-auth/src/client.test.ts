import { expect, test } from "bun:test";

const styles = await Bun.file(
  new URL("./client/styles.css", import.meta.url),
).text();

test("the sign-in page clears both mobile safe areas", () => {
  expect(styles).toMatch(
    /padding:\s*calc\(32px \+ var\(--frock-safe-top\)\)\s+32px\s+calc\(32px \+ var\(--frock-safe-bottom\)\)/,
  );
});
