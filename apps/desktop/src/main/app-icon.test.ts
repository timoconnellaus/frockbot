import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { setDevelopmentAppIcon } from "./app-icon.js";

describe("setDevelopmentAppIcon", () => {
  test("sets the sheep Dock icon during local macOS startup", async () => {
    const icons: string[] = [];
    const bundledMainUrl = new URL("../../out/main/index.js", import.meta.url)
      .href;

    const icon = setDevelopmentAppIcon(
      {
        isPackaged: false,
        dock: { setIcon: (path) => icons.push(path) },
      },
      "darwin",
      bundledMainUrl,
    );

    const expected = join(
      process.cwd(),
      "apps/desktop/resources/icons/512x512.png",
    );
    expect(icon).toBe(expected);
    expect(await Bun.file(expected).exists()).toBe(true);
    expect(icons).toEqual([expected]);
  });

  test("leaves packaged apps and non-macOS development unchanged", () => {
    const icons: string[] = [];
    const dock = { setIcon: (path: string) => icons.push(path) };

    expect(
      setDevelopmentAppIcon(
        { isPackaged: true, dock },
        "darwin",
        import.meta.url,
      ),
    ).toBeUndefined();
    expect(
      setDevelopmentAppIcon(
        { isPackaged: false, dock },
        "linux",
        import.meta.url,
      ),
    ).toBeUndefined();
    expect(icons).toEqual([]);
  });
});
