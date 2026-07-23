FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# The generator surface reuses the repository's TypeScript generation core.
# Rust is intentionally excluded: it is only used by batch simulation.
COPY gui ./gui
COPY src ./src
COPY tools ./tools
COPY config ./config
COPY strategies ./strategies
COPY replays ./replays

RUN mkdir -p \
      /app/.reversegen-cache/uploaded-terrains \
      /app/output/runs \
      /app/replays/generated \
      /data/levels \
  && chown -R node:node /app /data/levels

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80
ENV LEVELS_DIR=/data/levels
ENV APP_SURFACE=generator

USER node

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "gui"]
