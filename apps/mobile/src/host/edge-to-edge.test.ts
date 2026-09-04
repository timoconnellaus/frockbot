import { describe, expect, test } from "bun:test";

const mobileRoot = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, mobileRoot)).text();
}

describe("Android edge-to-edge shell", () => {
  test("draws the WebView behind transparent system bars with light icons", async () => {
    const activity = await source(
      "android/app/src/main/java/com/frockbot/mobile/MainActivity.java",
    );
    const theme = await source("android/app/src/main/res/values/styles.xml");

    expect(activity).toContain("WindowCompat.enableEdgeToEdge(getWindow());");
    expect(activity).toContain("setAppearanceLightStatusBars(false)");
    expect(activity).toContain("setAppearanceLightNavigationBars(false)");
    expect(activity).toContain("setNavigationBarContrastEnforced(false)");
    expect(theme).toContain(
      '<item name="android:statusBarColor">@android:color/transparent</item>',
    );
    expect(theme).toContain(
      '<item name="android:navigationBarColor">@android:color/transparent</item>',
    );
    expect(theme).toContain(
      '<item name="android:windowLightStatusBar">false</item>',
    );
    expect(theme).toContain(
      '<item name="android:windowLightNavigationBar">false</item>',
    );
  });

  test("uses the display cutout and resizes for the keyboard", async () => {
    const manifest = await source("android/app/src/main/AndroidManifest.xml");
    const theme = await source("android/app/src/main/res/values/styles.xml");
    const layout = await source(
      "android/app/src/main/res/layout/activity_main.xml",
    );

    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(theme).toContain(
      '<item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>',
    );
    expect(layout).not.toContain("fitsSystemWindows");
  });
});
