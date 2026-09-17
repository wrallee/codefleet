FROM node:24-bookworm-slim AS verify

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY test ./test
RUN npm run check

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=verify /app/src ./src

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "src/server.ts"]
