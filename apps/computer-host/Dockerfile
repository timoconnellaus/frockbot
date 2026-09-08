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
# Only the manifest, the protocol directory and the one Fly file are copied;
# the exports map resolves `@frockbot/computer/host-protocol` and
# `@frockbot/computer/fly/runtime` to them. `computer/fly` holds the rest of
# the Fly implementation, which runs in the Worker and is not copied.
COPY computer/package.json ./computer/package.json
COPY computer/host-protocol ./computer/host-protocol
COPY computer/fly/runtime.ts ./computer/fly/runtime.ts
RUN mkdir -p node_modules/@frockbot \
  && ln -s ../../computer node_modules/@frockbot/computer

COPY apps/computer-host/container ./container
RUN chmod 755 container/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./container/entrypoint.sh"]
