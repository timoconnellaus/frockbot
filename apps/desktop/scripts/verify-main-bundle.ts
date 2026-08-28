const mainBundlePath = new URL("../out/main/index.js", import.meta.url);
const mainBundle = await Bun.file(mainBundlePath).text();

if (!/\bfrom\s+["']electron["']/.test(mainBundle)) {
  throw new Error(
    "Desktop main bundle must keep Electron external to avoid bundling its CommonJS launcher",
  );
}

const externalWorkspaceImport = mainBundle.match(
  /\bfrom\s+["'](@frockbot\/[^"']+)["']/,
)?.[1];

if (externalWorkspaceImport) {
  throw new Error(
    `Desktop main bundle must compile workspace TypeScript instead of externalizing ${externalWorkspaceImport}`,
  );
}

console.log("Verified Electron main-process bundle boundaries.");
