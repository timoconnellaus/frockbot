FROM node:24-slim

WORKDIR /app

# Runtime dependencies only: the Sprites SDK and a WebSocket implementation.
# `npm ci` runs before the sources are copied so a source change does not
# reinstall them.
COPY apps/computer-host/container/package.json apps/computer-host/container/package-lock.json ./
RUN npm ci --omit=dev

# The two entry points of the `@frockbot/computer` module the container
# imports. They ship TypeScript sources and Node 24 strips the types, so there is no
# build step and no second copy of the protocol or the Computer runtime.
#
# The module lives outside `node_modules` and is reached through a symlink into
# it, because Node refuses to strip types from a file under `node_modules`
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and resolves a symlink to its
# real path before deciding. This is the same shape a workspace install has.
# Only the manifest, the protocol directory, the Bot path-key leaf, the Fly
# runtime file and the Linux runtime it binds (with the leaves that imports)
# and the `core` leaves they reach are copied; the exports maps resolve
# `@frockbot/computer/host-protocol`, `@frockbot/computer/core/bot-path`,
# `@frockbot/computer/fly/runtime`, `@frockbot/core/crypto` and
# `@frockbot/core/contracts/canonical-json` to them. The rest of `computer`
# and `core` runs in the Worker and is not copied.
# A file reached through a relative `.js` specifier is stripped to that name.
# `container/image-layout.test.ts` lays these files out the same way and loads
# every module the container imports.
COPY computer/package.json ./computer/package.json
COPY computer/host-protocol ./computer/host-protocol
COPY computer/core/bot-path.ts ./computer/core/bot-path.ts
COPY computer/fly/runtime.ts ./computer/fly/runtime.ts
COPY computer/linux-runtime/runtime.ts ./computer/linux-runtime/runtime.ts
COPY computer/linux-runtime/shell.ts ./computer/linux-runtime/shell.ts
COPY computer/linux-runtime/demonstration.ts ./computer/linux-runtime/demonstration.ts
COPY computer/linux-runtime/egress.ts ./computer/linux-runtime/egress.ts
COPY computer/egress.ts ./computer/egress.ts
COPY core/package.json ./core/package.json
COPY core/crypto.ts ./core/crypto.ts
COPY core/contracts/canonical-json.ts ./core/contracts/canonical-json.ts
RUN node --no-warnings -e \
  "const fs = require('node:fs'); const { stripTypeScriptTypes } = require('node:module'); for (const leaf of ['computer/linux-runtime/runtime', 'computer/linux-runtime/shell', 'computer/linux-runtime/demonstration', 'computer/linux-runtime/egress', 'computer/egress', 'core/crypto']) { const source = fs.readFileSync(leaf + '.ts', 'utf8'); fs.writeFileSync(leaf + '.js', stripTypeScriptTypes(source, { mode: 'strip' })); }"
RUN mkdir -p node_modules/@frockbot \
  && ln -s ../../computer node_modules/@frockbot/computer \
  && ln -s ../../core node_modules/@frockbot/core

COPY apps/computer-host/container ./container
RUN chmod 755 container/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./container/entrypoint.sh"]
