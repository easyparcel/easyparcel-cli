# syntax=docker/dockerfile:1
# EasyParcel MCP server — container image for the HTTP/OAuth transport.
#
#   docker build -t <registry>/easyparcel-mcp:0.1.3 .
#   docker run -p 8790:8790 <registry>/easyparcel-mcp:0.1.3 \
#       mcp --http --host 0.0.0.0 --port 8790 --oauth --public-url https://mcp.easyparcel.com
#
# The default CMD runs the HTTP MCP server; k8s overrides `args` (see deploy/k8s).

# ---- build (needs devDeps: tsup, typescript) ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --ignore-scripts skips the postinstall native-binary download (not needed in the container).
RUN npm ci --omit=dev --ignore-scripts

# ---- runtime ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
USER app
EXPOSE 8790
ENTRYPOINT ["node", "dist/index.js"]
CMD ["mcp", "--http", "--host", "0.0.0.0", "--port", "8790"]
