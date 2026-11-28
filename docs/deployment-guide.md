# Deployment Guide

This guide provides instructions for setting up the Converge application for local development and for deployment using Docker.

## Local Development Setup

### Prerequisites

- Node.js (version specified in `.nvmrc` if available)
- [bun](https://bun.sh/) (package manager)

### 1. Install Dependencies

Clone the repository and install the required packages:

```bash
bun install
```

### 2. Configure Environment Variables

Copy the example environment file and fill in the required values:

```bash
cp .env.example .env
```

Open the `.env` file and set the following variables:

**Required:**

- `DATABASE_URL`: The connection string for the database. For local development, the default is `file:./prisma/dev.db`.
- `APP_ENCRYPTION_KEY`: A secret key used for encrypting stored Redmine API keys. Generate a secure random string for this.
- `SESSION_SECRET`: A secret key used for signing session cookies. Generate a secure random string for this.
- `SECURE_COOKIES`: Set to `false` for plain-HTTP Docker/Pi/homelab access so browsers keep the login cookie. Only do this on a trusted local network — over plain HTTP the `rd_session` cookie is sent in cleartext and can be intercepted by anything on the same network path. Omit or set to `true` (and require HTTPS) for any deployment reachable over an untrusted or public network.

**Recommended (Sentry error/performance/logs/profiling):**

- `SENTRY_DSN`: Server-side DSN used by Node/Edge Sentry initialization.
- `SENTRY_ORG`: Sentry org slug used with `SENTRY_AUTH_TOKEN` to upload source maps at build time.
- `NEXT_PUBLIC_SENTRY_DSN`: Client-side DSN used by browser Sentry initialization.
- `SENTRY_TRACES_SAMPLE_RATE`: Trace sampling ratio. Recommended defaults: `0.0` in local dev, `0.1` in production.
- `SENTRY_PROFILE_SAMPLE_RATE`: Profiling sampling ratio. Recommended default: `0.0` unless actively profiling.
- `SENTRY_ENABLE_LOGS`: Enables Sentry logs pipeline (`false` by default).
- `SENTRY_ENABLE_CONSOLE_LOGGING`: Sends `console.log/warn/error` to Sentry (`false` by default).
- `SENTRY_SEND_DEFAULT_PII`: Sends default server-side PII to Sentry (`false` by default).
- `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_PROFILE_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_ENABLE_LOGS`,
  `NEXT_PUBLIC_SENTRY_ENABLE_CONSOLE_LOGGING`, `NEXT_PUBLIC_SENTRY_SEND_DEFAULT_PII`: Browser-side Sentry controls; keep
  aligned with the server settings you intentionally want exposed to client builds.
- `ENABLE_SENTRY_TEST_ROUTES` and `NEXT_PUBLIC_ENABLE_SENTRY_TEST_ROUTES`: Enables local Sentry smoke-test routes/pages (`false` by default).

**Recommended (runtime memory controls):**

- `ENABLE_SYNC_POLLER`: Controls background sync poller startup. Recommended defaults: `false` in local dev, `true` in production.
- `POLL_INTERVAL_MS`: Sync poller interval in milliseconds. Recommended default: `300000`.
- `MEMORY_LOGGING`: Enables periodic `process.memoryUsage()` logging (`false` by default).
- `MEMORY_LOG_INTERVAL_MS`: Interval for memory logs in milliseconds (default: `60000`).

**Optional (Streamline log poller):**

- `ENABLE_STREAMLINE_LOG_POLLER`: Enables auto-fetching of Streamline logs into the database. Defaults to `false`.
- `STREAMLINE_LOG_POLL_INTERVAL_MS`: Log poller interval in milliseconds. Default: `300000` (5 minutes).
- `STREAMLINE_LOG_LOCK_TTL_MS`: Leader lock TTL for the log poller. Default: `90000` (90 seconds).
- `STREAMLINE_ENV`: Streamline environment to fetch logs from (`staging` or `production`). Default: `staging`.
- `STREAMLINE_HOST`: Portal host (bare hostname) for the single-portal setup. Required unless `STREAMLINE_PORTALS` is set; there is no built-in default host.
- `STREAMLINE_LOG_FETCH_LIMIT`: Page size per log type (max `1000`, the portal API's limit). Each poll pages back until it reaches the newest record already stored for that portal, up to 20 pages, so a gap between polls doesn't drop records; hitting the cap logs `streamline_log_poller.portal.fetch_capped`. The first poll for a portal fetches one page. Default: `100`.
- `STREAMLINE_PORTALS`: Comma-separated portal names (for example `sa,drc`) to poll several Streamline portals. When set, `STREAMLINE_ENV` and `STREAMLINE_TOKEN` are ignored and each portal is read from `STREAMLINE_PORTAL_<NAME>_HOST` (required, bare hostname), `STREAMLINE_PORTAL_<NAME>_TOKEN`, `STREAMLINE_PORTAL_<NAME>_ENV` (default `production`) and `STREAMLINE_PORTAL_<NAME>_API`, the custom-objects API serving `get_all` (default `rest_test`; some portals use `rest_api`). Logs keep their source host, so Heimdall shows which portal each came from.

**Optional (for first-run bootstrap):**

- `REDMINE_BASE_URL`: The base URL of your Redmine instance (e.g., `https://redmine.example.com`).
- `REDMINE_API_KEY`: Your Redmine API key.
- `REDMINE_ALLOWED_BASE_URLS`: Optional comma-separated allowlist for connect/pair flows (e.g.,
  `https://redmine.example.com,https://redbrick.example.com`).
- `REDMINE_INSECURE_TLS_HOSTS`: Optional comma-separated hostnames allowed to bypass TLS verification (recommended only for staging with incomplete
  certificate chains).
- `REDMINE_SYNC_ISSUE_SCOPE`: Sync scope for `/issues.json` pulls. Allowed values: `assigned` (default, `assigned_to_id=me`), `open` (`status_id=open`),
  `all` (`status_id=*`).

### 3. Initialize the Database

Run the following command to initialize the local SQLite database schema:

```bash
bun run db:init
```

### 4. Start the Application

Start the Next.js development server:

```bash
bun run dev
```

The application will be available at [http://localhost:3000](http://localhost:3000).

## Docker Setup

A Docker setup is provided for a containerized development environment. For more details, see
[DOCKER.md](../DOCKER.md).

Docker images run on PostgreSQL only. SQLite needs the native `better-sqlite3` addon behind the Prisma 7 adapter, and the images run on Bun, which cannot load it, so the `Dockerfile` refuses to build with the SQLite schema. SQLite still works for local development outside Docker.

### Quick Start

1. **Configure Environment:** Copy the `.env.example` file to `.env`. `make up` starts the PostgreSQL-backed stack (`docker-compose.yml`'s `dashboard` service reads `DOCKER_POSTGRES_DATABASE_URL`), so that's the connection string that matters here — `DOCKER_DATABASE_URL` isn't referenced by the current Compose setup at all.
   ```bash cp .env.example .env
   ```
2. **Start Services:** Use the Makefile to build and start the containers. ```bash
   make up ```
3. **View Logs:** ```bash
   make logs ```
4. **Stop Services:** ```bash
   make down ```
5. **Reset Database:** To wipe the Docker Postgres volume and start fresh (destructive — this deletes all data in the `postgres-data` volume):
   ```bash docker compose down -v
   make up
   ```

### Supabase -> Local Docker Postgres Import

If you want Docker to run on a local Postgres copy of Supabase data:

1. Import Supabase into local Docker Postgres. Passing the URL directly on the `make` command line leaves it in your shell history and visible to other processes on the same machine (`ps`) — export it first instead:
   ```bash
   export SUPABASE_DATABASE_URL="postgresql://user:pass@host:5432/postgres"
   make import-supabase
   unset SUPABASE_DATABASE_URL
   ```
   The importer excludes Supabase-managed extension objects (`pg_graphql`, `supabase_vault`) during restore.
2. Start the stack: ```bash
   make up ```
3. Tail logs: ```bash
   make logs ```
4. Stop the stack: ```bash
   make down ```

A full list of helper targets is available in the [Makefile](../Makefile).

## Environment Variables Reference

- `DATABASE_URL`: SQLite file path for local development (default: `file:./prisma/dev.db`). If regenerating Prisma for this mode, run `bun run prisma:generate:sqlite`; `bun run prisma:generate` generates the PostgreSQL client.
- `DOCKER_DATABASE_URL`: not referenced by the current `docker-compose.yml` — the dashboard service reads `DOCKER_POSTGRES_DATABASE_URL` instead. Docker images are Postgres-only, so there is no SQLite-mode Compose setup that would use it.
- `DOCKER_POSTGRES_DB`: Local Docker Postgres DB name.
- `DOCKER_POSTGRES_USER`: Local Docker Postgres username.
- `DOCKER_POSTGRES_PASSWORD`: Local Docker Postgres password.
- `DOCKER_POSTGRES_PORT`: Host port mapping for local Docker Postgres (default: `5433`).
- `DOCKER_POSTGRES_DATABASE_URL`: Dashboard connection string used by `docker-compose.yml`'s `dashboard` service.
- `SUPABASE_DATABASE_URL`: Optional convenience variable used by `make import-supabase`.
- `APP_ENCRYPTION_KEY`: Secret key for encrypting Redmine API keys at rest.
- `SESSION_SECRET`: HMAC secret for signing session cookies.
- `SENTRY_DSN`: Optional but recommended for server-side Sentry telemetry.
- `NEXT_PUBLIC_SENTRY_DSN`: Optional but recommended for browser-side Sentry telemetry.
- `SENTRY_TRACES_SAMPLE_RATE`: Trace sampling ratio. Defaults to `0.0` in development and `0.1` in production.
- `SENTRY_PROFILE_SAMPLE_RATE`: Profiling sampling ratio. Defaults to `0.0`.
- `SENTRY_ENABLE_LOGS`: Enables Sentry logs pipeline (`false` by default).
- `SENTRY_ENABLE_CONSOLE_LOGGING`: Sends `console.log/warn/error` to Sentry (`false` by default).
- `SENTRY_SEND_DEFAULT_PII`: Sends default server-side PII to Sentry (`false` by default).
- `NEXT_PUBLIC_SENTRY_*`: Browser-side equivalents for trace/profile/log/PII controls.
- `ENABLE_SENTRY_TEST_ROUTES` / `NEXT_PUBLIC_ENABLE_SENTRY_TEST_ROUTES`: Optional Sentry smoke-test surface; leave disabled outside intentional
  telemetry checks.
- `ENABLE_SYNC_POLLER`: Enables background sync polling. Defaults to `false` in development and `true` in production.
- `POLL_INTERVAL_MS`: The interval for the sync poller in milliseconds (default: `300000`).
- `LEADER_LOCK_TTL_MS`: The time-to-live for the leader lock in milliseconds (default: `90000`).
- `SYNC_JOB_STALE_MS`: Timeout in milliseconds for resetting stale running or pending sync jobs (default: `600000`).
- `MEMORY_LOGGING`: Enables structured memory usage logging (`false` by default).
- `MEMORY_LOG_INTERVAL_MS`: Memory log interval in milliseconds (default: `60000`).
- `ENABLE_STREAMLINE_LOG_POLLER`: Enables the Streamline log poller for auto-fetching logs (`false` by default).
- `STREAMLINE_LOG_POLL_INTERVAL_MS`: Log poller interval in milliseconds (default: `300000`).
- `STREAMLINE_LOG_LOCK_TTL_MS`: Leader lock TTL for log poller in milliseconds (default: `90000`).
- `STREAMLINE_ENV`: Streamline environment (`staging` or `production`; default: `staging`).
- `STREAMLINE_HOST`: Portal host for the single-portal setup; required unless `STREAMLINE_PORTALS` is set.
- `STREAMLINE_LOG_FETCH_LIMIT`: Page size per log type per poll, max `1000` (default: `100`; see above).
- `STREAMLINE_PORTALS`: Poll several portals, each configured by `STREAMLINE_PORTAL_<NAME>_HOST`, `_TOKEN`, `_ENV` and `_API` (see above).
- `REDMINE_BASE_URL`: Optional. Used for first-run bootstrap to pre-configure the Redmine connection.
- `REDMINE_API_KEY`: Optional. Used for first-run bootstrap.
- `REDMINE_ALLOWED_BASE_URLS`: Optional comma-separated Redmine base URL allowlist for user-provided connect/pair requests.
- `REDMINE_INSECURE_TLS_HOSTS`: Optional comma-separated hostname list for insecure TLS override on specific Redmine hosts.
- `REDMINE_SYNC_ISSUE_SCOPE`: Optional sync scope override for Redmine issue imports (`assigned`, `open`, `all`; default `assigned`).

## Security Notes

- Do not commit `.env` to Git.
- Replace placeholder values (especially `SESSION_SECRET`) before deployment.
- Keep Sentry DSNs in environment variables instead of hardcoding them in source files.

## Available Scripts

- `bun run dev`: Starts the development server.
- `bun run mem:dev`: Starts the development server with periodic memory usage logging enabled.
- `bun run build`: Creates a production build of the application.
- `bun run start`: Starts a production server.
- `bun run mem:start`: Starts the production server with periodic memory usage logging enabled.
- `bun run lint`: Lints the codebase for errors and style issues.
- `bun run test`: Runs the test suite.
- `bun run prisma:generate`: Regenerates the Prisma client.
- `bun run db:init`: Initializes the database schema.

## Production Runtime Profile

For memory-constrained production environments, start the app with:

```bash
NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768 bun run start
```

Use this as a starting point and tune heap size based on GC behavior and request latency.

## Continuous Integration (CI) and Branch Protection

- **CI Workflow:** The CI pipeline is defined in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
- **Job chain:** `lint → typecheck → test → build → a11y → e2e`, run sequentially via `needs:` so a failure early (e.g. lint) skips the rest
  instead of burning CI minutes on jobs that were never going to matter.
- **Concurrency:** A new push to the same branch cancels any in-flight run for that branch (`concurrency:` block at the top of the workflow).
- **Required Status Checks:** All six jobs (`lint`, `typecheck`, `test`, `build`, `a11y`, `e2e`) should be required for pull requests to be mergeable.

### Recommended Branch Protection for `master`

The default branch is `master`. To protect it, configure the following rules in your GitHub repository settings:

- Require a pull request before merging.
- Require status checks to pass before merging.
  - Enable strict mode: Require branches to be up to date before merging.
- Add `lint`, `typecheck`, `test`, `build`, `a11y`, and `e2e` as required status checks.
- Optionally, include administrators in the branch protection rules.
