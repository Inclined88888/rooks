# Orchestrator: needs build tools for node-pty + better-sqlite3, plus the
# two provider CLIs we spawn (Claude Code, OpenAI Codex) so per-agent
# `backend: claude|codex` config can pick either.

FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Runtime deps + both provider CLIs. Codex ships native binaries via
# per-platform npm packages pulled in transitively by @openai/codex.
# Docker CLI + compose plugin are installed from docker.com so agents
# running inside the orchestrator container can drive the host docker
# daemon via the mounted /var/run/docker.sock — Docker-outside-of-Docker
# pattern (we never run a daemon in here).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
       docker-ce-cli docker-compose-plugin docker-buildx-plugin \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code @openai/codex

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# `rooks` CLI for sub-agents to discover peers, spawn missions, etc.
# Lives in $PATH so any spawned `claude` can run `rooks spawn …`.
COPY bin/rooks /usr/local/bin/rooks
RUN chmod +x /usr/local/bin/rooks

# Permission-prompt MCP server, spawned by claude per-mission via
# --permission-prompt-tool mcp__nova_ask__request.
COPY bin/permission-mcp.mjs /app/bin/permission-mcp.mjs
RUN chmod +x /app/bin/permission-mcp.mjs

# Official ROOKS MCP server: kanban_* + mission_spawn tools, spawned
# alongside permission-mcp by every claude agent.
COPY bin/rooks-mcp.mjs /app/bin/rooks-mcp.mjs
RUN chmod +x /app/bin/rooks-mcp.mjs

ENV NODE_ENV=production
ENV ROOKS_HOME=/data/.rooks
EXPOSE 3000
CMD ["node", "dist/index.js"]
