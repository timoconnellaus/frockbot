const fs = require("fs");
const path = require("path");
const sharp = require("/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");
const root = path.resolve(__dirname, "..");
(async () => {
  for (const name of ["guardian", "pixel", "sunny"]) {
    await sharp(path.join(root, "parts", name + ".svg"))
      .png()
      .toFile(path.join(root, "parts", name + "-render.png"));
    await sharp(path.join(root, "svg", name + ".svg"))
      .png()
      .toFile(path.join(root, "parts", name + "-reference-render.png"));
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
