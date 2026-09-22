FROM node:24-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates python3 python3-venv \
 && python3 -m venv /opt/graphify \
 && /opt/graphify/bin/pip install --no-cache-dir graphifyy==0.9.65 \
 && rm -rf /var/lib/apt/lists/*

ENV GRAPHIFY_BIN=/opt/graphify/bin/graphify

FROM base AS verify

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY config ./config
COPY src ./src
COPY test ./test
COPY test-fixtures ./test-fixtures
RUN npm run check
RUN /opt/graphify/bin/python -m py_compile src/graphify/worker.py
RUN test -f /opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/LICENSE \
 && test -f /opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/LICENSE-MIT \
 && test -f /opt/graphify/lib/python*/site-packages/graphifyy-*.dist-info/licenses/NOTICE
RUN npm prune --omit=dev

FROM base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY config ./config
COPY --from=verify /app/node_modules ./node_modules
COPY --from=verify /app/src ./src
RUN mkdir /data && chown node:node /data

EXPOSE 3000
VOLUME ["/data"]
USER node

CMD ["node", "src/server.ts"]
