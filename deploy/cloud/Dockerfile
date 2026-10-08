# Build from the repository root: docker build -f deploy/cloud/Dockerfile .
# Base images and dependencies are multi-arch (Oracle Ampere A1 is linux/arm64).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/cloud/package.json apps/cloud/
RUN npm ci -w @local-cognitive/cloud --include-workspace-root=false --ignore-scripts
COPY apps/cloud/tsconfig.json apps/cloud/
COPY apps/cloud/src apps/cloud/src
RUN npm run build -w @local-cognitive/cloud

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/cloud/package.json apps/cloud/
RUN npm ci -w @local-cognitive/cloud --include-workspace-root=false --ignore-scripts --omit=dev && npm cache clean --force
COPY --from=build /app/apps/cloud/dist/src apps/cloud/dist/src
COPY apps/cloud/migrations apps/cloud/migrations
WORKDIR /app/apps/cloud
USER node
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
