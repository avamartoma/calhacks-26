FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-env
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json server.ts ./
RUN npx tsc
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
