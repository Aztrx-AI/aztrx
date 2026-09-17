# Aztrx MCP over HTTP — a container with the swarm AND its browser.
# Built from the repo root; the MCP server imports the core by relative path.

FROM node:20-slim

WORKDIR /app

# Chromium for Playwright — the swarm drives a real browser.
RUN npx --yes playwright@1.62.1 install --with-deps chromium

# The core and its deps.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# The MCP server.
COPY mcp-server/package.json mcp-server/package-lock.json mcp-server/
RUN cd mcp-server && npm ci
COPY mcp-server ./mcp-server

ENV PORT=8080
EXPOSE 8080

WORKDIR /app/mcp-server
CMD ["npx", "tsx", "src/index.ts"]
