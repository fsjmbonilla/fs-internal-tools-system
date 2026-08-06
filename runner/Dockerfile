# The script runner.
#
# python3 lives in the runtime image because that is what this service exists to
# execute. Node builds the supervisor; Python runs the scripts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# python3 only — no pip, no build toolchain. A script that cannot install
# packages cannot pull one in as a way out of the sandbox.
RUN apk add --no-cache python3
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Non-root, and the scratch dirs land under its own home.
USER node
CMD ["node", "dist/index.js"]
