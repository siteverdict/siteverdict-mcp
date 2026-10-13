# SiteVerdict MCP server — container image (Docker MCP Catalog, Glama, self-hosting).
# Default: stdio (what Docker MCP Toolkit / Glama expect). For HTTP: docker run -e SITEVERDICT_HTTP_HOST=0.0.0.0 -p 3333:3333 IMAGE --http
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json brand.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL io.modelcontextprotocol.server.name="io.github.siteverdict/siteverdict"
LABEL org.opencontainers.image.title="SiteVerdict MCP server" \
      org.opencontainers.image.description="Website audit tools for AI agents (consent, speed, WCAG, email/DNS, AI search) via Apify Actors" \
      org.opencontainers.image.source="https://github.com/siteverdict/siteverdict-mcp"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json brand.json ./
USER node
ENTRYPOINT ["node", "dist/cli.js"]
