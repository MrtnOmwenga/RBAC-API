# Build on Debian (glibc) to match the distroless runtime: @node-rs/argon2 ships native binaries.
FROM node:24-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# No shell, no package manager, not root.
FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
EXPOSE 3000
CMD ["dist/main.js"]
