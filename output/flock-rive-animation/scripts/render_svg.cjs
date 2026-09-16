const path = require("path");
let sharp;
try {
  sharp = require("sharp");
} catch {
  sharp = require("/Users/tim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");
}
const root = path.resolve(__dirname, "..", "characters");
(async () => {
  for (const name of "guardian sunny chill nudge fox dog goat cow cat rabbit".split(
    " ",
  )) {
    await sharp(path.join(root, name, `${name}.svg`))
      .png()
      .toFile(path.join(root, name, `${name}.png`));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
