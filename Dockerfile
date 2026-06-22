# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

# install deps (including dev, for tsc typecheck) using the lockfile
COPY package.json package-lock.json* ./
RUN npm install

# copy source + config
COPY tsconfig.json ./
COPY src ./src

# typecheck at build time so a broken build never ships
RUN npx tsc --noEmit

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# default to dry-run inside the image; override at deploy time if ever going live
ENV DRY_RUN=true

# only production deps in the final image
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# tsx is needed to run TS directly; keep it as a runtime dep via npx
RUN npm install tsx@4.22.4

COPY tsconfig.json ./
COPY src ./src

# data dir for the CSV + stats (mount a volume here)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# run as non-root
RUN chown -R node:node /app
USER node

# the bot is a long-running loop; SIGTERM triggers graceful flush
STOPSIGNAL SIGTERM

# status dashboard port
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]