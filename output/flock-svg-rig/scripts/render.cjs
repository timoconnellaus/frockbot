const fs = require("fs"),
  path = require("path");
const sharp = require("/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");
const root = path.resolve(__dirname, ".."),
  version = process.argv[2];
(async () => {
  for (const name of ["guardian", "pixel", "sunny"]) {
    const file = path.join(root, "versions", version, name);
    const svg = fs.readFileSync(file + ".svg", "utf8");
    if (/<image\b|data:image|<foreignObject\b/i.test(svg))
      throw Error("Embedded raster or external object found");
    await sharp(Buffer.from(svg))
      .png()
      .toFile(file + "-render.png");
    console.log("Rendered", name);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
