FROM node:24-bookworm-slim

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash build-essential ca-certificates curl git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @openai/codex @anthropic-ai/claude-code
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.mjs"]
