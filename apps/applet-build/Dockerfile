FROM node:24-slim

WORKDIR /app

# The Applets SDK's runtime dependencies — the type checker, ESLint, esbuild
# and Miniflare. `npm ci` runs before the sources are copied so a source change
# does not reinstall them. `.npmrc` beside the manifest says why the peer
# resolution is relaxed.
COPY apps/applet-build/container/package.json apps/applet-build/container/package-lock.json apps/applet-build/container/.npmrc ./
RUN npm ci --omit=dev

# The SDK itself comes from the repository rather than from npm: the pipeline
# in this image is then the pipeline in this commit, and the release is not
# gated on a publish. `applets/build-contract.ts` is the wire protocol both
# sides of the seam import.
COPY applets/package.json ./applets/package.json
COPY applets/build-contract.ts ./applets/build-contract.ts
COPY applets/sdk ./applets/sdk
RUN mkdir -p node_modules/@frockbot \
  && ln -s ../../applets node_modules/@frockbot/applets \
  && ln -s ../../applets/sdk node_modules/@frockbot/applet-sdk \
  && ln -s /app/node_modules applets/sdk/node_modules

COPY apps/applet-build/container ./container
RUN chmod 755 container/entrypoint.sh

# The pipeline's sources resolve their siblings through `.js` specifiers, which
# esbuild and Bun honour and Node's ESM resolver does not. So the server is
# bundled here, with the four packages that load their own workers, binaries
# and WASM by path left external.
#
# The output lands in the SDK's own `dist/` on purpose: `paths.ts` finds the SDK
# root by walking up to the `package.json` that names it, and from there the
# entries, the ambient Workers declarations and `node_modules` all resolve.
RUN node_modules/.bin/esbuild container/server.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --external:typescript --external:eslint --external:typescript-eslint \
  --external:esbuild --external:miniflare \
  --outfile=applets/sdk/dist/build-server.mjs

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./container/entrypoint.sh"]
