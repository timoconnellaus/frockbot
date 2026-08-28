/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const file = (path: string) => Bun.file(new URL(path, root));

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await file(path).arrayBuffer());
}

async function pngInfo(path: string) {
  const data = await bytes(path);
  expect(new TextDecoder().decode(data.slice(1, 4))).toBe("PNG");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: view.getUint8(25),
  };
}

describe("generated app icons", () => {
  test("Electron packaging references native icon formats for each configured platform", async () => {
    const desktopPackage = await file("apps/desktop/package.json").json();

    expect(desktopPackage.build.mac.icon).toBe("resources/icon.icns");
    expect(desktopPackage.build.win.icon).toBe("resources/icon.ico");
    expect(desktopPackage.build.linux.icon).toBe("resources/icons");
    expect(desktopPackage.scripts.package).toContain("electron-builder");

    const icns = await bytes("apps/desktop/resources/icon.icns");
    expect(new TextDecoder().decode(icns.slice(0, 4))).toBe("icns");

    const ico = await bytes("apps/desktop/resources/icon.ico");
    const icoView = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([icoView.getUint16(0, true), icoView.getUint16(2, true)]).toEqual([
      0, 1,
    ]);
    const icoSizes = Array.from(
      { length: icoView.getUint16(4, true) },
      (_, index) => icoView.getUint8(6 + index * 16) || 256,
    );
    expect(icoSizes).toEqual([256, 128, 64, 48, 32, 16]);

    for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
      expect(await pngInfo(`apps/desktop/resources/icons/${size}x${size}.png`)).toMatchObject(
        { width: size, height: size },
      );
    }
  });

  test("Android launcher and adaptive resources have platform density dimensions", async () => {
    const sizes: Record<string, [number, number]> = {
      mdpi: [48, 108],
      hdpi: [72, 162],
      xhdpi: [96, 216],
      xxhdpi: [144, 324],
      xxxhdpi: [192, 432],
    };

    for (const [density, [legacy, foreground]] of Object.entries(sizes)) {
      const directory = `apps/mobile/android/app/src/main/res/mipmap-${density}`;
      expect(await pngInfo(`${directory}/ic_launcher.png`)).toMatchObject({
        width: legacy,
        height: legacy,
      });
      expect(await pngInfo(`${directory}/ic_launcher_round.png`)).toMatchObject({
        width: legacy,
        height: legacy,
      });
      expect(await pngInfo(`${directory}/ic_launcher_foreground.png`)).toMatchObject({
        width: foreground,
        height: foreground,
        colorType: 6,
      });
    }

    const manifest = await file(
      "apps/mobile/android/app/src/main/AndroidManifest.xml",
    ).text();
    const adaptive = await file(
      "apps/mobile/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml",
    ).text();
    const background = await file(
      "apps/mobile/android/app/src/main/res/values/ic_launcher_background.xml",
    ).text();
    expect(manifest).toContain('android:icon="@mipmap/ic_launcher"');
    expect(manifest).toContain('android:roundIcon="@mipmap/ic_launcher_round"');
    expect(adaptive).toContain('@mipmap/ic_launcher_foreground');
    expect(background).toContain("#EC386B");
  });

  test("iOS asset catalog points to an opaque 1024px App Store icon", async () => {
    const contents = await file(
      "apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json",
    ).json();
    expect(contents.images).toContainEqual(
      expect.objectContaining({
        filename: "AppIcon-512@2x.png",
        idiom: "universal",
        platform: "ios",
        size: "1024x1024",
      }),
    );
    expect(
      await pngInfo(
        "apps/mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png",
      ),
    ).toEqual({ width: 1024, height: 1024, colorType: 2 });
  });

  test("the repeatable generator uses the canonical marketing sheep icon", async () => {
    const generator = await file("scripts/generate-app-icons.sh").text();
    expect(generator).toContain(
      "assets/marketing/app-icon/frockbot-icon-1024.png",
    );
    expect(generator).toContain("apps/desktop/resources");
    expect(generator).toContain("apps/mobile/android/app/src/main/res");
    expect(generator).toContain("Assets.xcassets/AppIcon.appiconset");
  });
});
