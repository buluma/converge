FROM oven/bun:1-alpine

WORKDIR /app
ARG PRISMA_SCHEMA=prisma/schema.prisma
# Postgres is the only database this image supports. SQLite needs the native
# better-sqlite3 addon behind the Prisma 7 adapter, and Bun refuses to load it
# ("not yet supported in Bun"), so a SQLite image would build and then fail at
# runtime. Fail the build instead. SQLite still works for local dev outside Docker.
RUN if [ "$PRISMA_SCHEMA" != "prisma/schema.prisma" ]; then \
      echo "Unsupported PRISMA_SCHEMA=$PRISMA_SCHEMA: Docker images are Postgres-only (prisma/schema.prisma)" >&2; \
      exit 1; \
    fi

# Install dependencies for native modules
RUN apk add --no-cache sqlite openssl ca-certificates python3 make g++ libstdc++

# Copy package files first for better caching
COPY package.json bun.lock ./
COPY prisma ./prisma
# patchedDependencies in package.json must exist before bun install.
COPY patches ./patches
RUN bun install --frozen-lockfile --ignore-scripts
COPY prisma.config.ts ./prisma.config.ts

# Copy Prisma schema
COPY prisma ./prisma

# Generate Prisma client for the selected runtime database schema
RUN bunx prisma generate --schema=${PRISMA_SCHEMA}

# Copy source code
COPY . .

# NEXT_PUBLIC_* values are inlined into the bundles at build time, so they come
# in as build args. One left unset stays undefined, not "", as it would be with
# no .env at all.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_ENABLE_LOGS
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY

# Build the application. .env files are not in the build context, so the
# variables env.ts requires at import get throwaway values generated for this
# step only; real values come from the container environment at runtime.
# Prisma 7 rejects a DATABASE_URL whose driver does not match the generated
# client, so the build gets a placeholder Postgres URL. The build never
# connects.
RUN for v in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SENTRY_DSN NEXT_PUBLIC_SENTRY_ENABLE_LOGS NEXT_PUBLIC_VAPID_PUBLIC_KEY; do \
      eval "[ -n \"\${$v}\" ] || unset $v"; \
    done && \
    export DATABASE_URL="postgresql://build:build@localhost:5432/build" \
      APP_ENCRYPTION_KEY="$(head -c 32 /dev/urandom | base64)" \
      SESSION_SECRET="$(head -c 32 /dev/urandom | base64)" && \
    bun run build

# Copy public assets and static chunks into standalone output so they are served
RUN cp -r public .next/standalone/public && \
    cp -r .next/static .next/standalone/.next/static

# Expose port
EXPOSE 3000
ENV HOSTNAME "0.0.0.0"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

# Run database init and start the app via the standalone server
CMD ["sh", "-c", "bun run db:init && exec bun .next/standalone/server.js"]
