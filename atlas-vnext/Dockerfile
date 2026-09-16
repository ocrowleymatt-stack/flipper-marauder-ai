FROM node:20-bookworm-slim

WORKDIR /srv/atlas-vnext

COPY package.json package-lock.json ./
COPY packages ./packages
COPY platform ./platform
COPY dungeons ./dungeons
COPY apps ./apps
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts ./

RUN npm ci && npm run build -w @atlas-vnext/web

ENV NODE_ENV=production
ENV ATLAS_PERSISTENCE=postgres
EXPOSE 8787

CMD ["npx", "tsx", "apps/host/src/main.ts"]
