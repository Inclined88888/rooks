FROM node:20-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json next.config.mjs next-env.d.ts ./
COPY tailwind.config.ts postcss.config.js components.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.mjs ./
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src

ENV NODE_ENV=production
ENV TIMON_HOME=/data/.timon
EXPOSE 3100
CMD ["npx", "tsx", "src/server.ts"]
