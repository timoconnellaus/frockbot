FROM node:24-slim

WORKDIR /app

# Runtime dependencies only: the Sprites SDK and a WebSocket implementation.
# `npm ci` runs before the sources are copied so a source change does not
# reinstall them.
COPY apps/computer-host/container/package.json apps/computer-host/container/package-lock.json ./
RUN npm ci --omit=dev

# The two workspace packages the container imports. They ship TypeScript
# sources and Node 24 strips the types, so there is no build step and no
# second copy of the protocol or the Computer runtime.
#
# They live outside `node_modules` and are reached through symlinks into it,
# because Node refuses to strip types from a file under `node_modules`
# (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) and resolves a symlink to its
# real path before deciding. This is the same shape a workspace install has.
COPY packages/computer-host-protocol ./packages/computer-host-protocol
COPY packages/computer-host-runtime ./packages/computer-host-runtime
RUN mkdir -p node_modules/@frockbot \
  && ln -s ../../packages/computer-host-protocol node_modules/@frockbot/computer-host-protocol \
  && ln -s ../../packages/computer-host-runtime node_modules/@frockbot/computer-host-runtime

COPY apps/computer-host/container ./container
RUN chmod 755 container/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./container/entrypoint.sh"]
