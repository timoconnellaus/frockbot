FROM node:24-bookworm-slim

WORKDIR /app
COPY container/package.json container/package-lock.json ./
RUN npm ci --omit=dev
COPY container ./container
RUN chmod 755 container/entrypoint.sh

ENV PORT=8080
EXPOSE 8080
USER node
CMD ["./container/entrypoint.sh"]
