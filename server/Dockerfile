# Compile the ingest server to plain JS, then run it in a slim image.
# The store is a JSON-file tree — mount a volume at /data and that is the
# whole state. Keys come from AZTRX_API_KEYS in the host's environment:
# the in-repo keys.json fallback cannot exist in the runtime image.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.json
COPY server/ server/
RUN npx tsc -p server/tsconfig.build.json

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production AZTRX_PORT=8787 AZTRX_DATA_DIR=/data
COPY --from=build /app/server/dist ./server-dist
EXPOSE 8787
CMD ["node", "server-dist/index.js"]
