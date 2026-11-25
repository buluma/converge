/**
 * Streamline Logs Import Library
 *
 * Reusable import functions used by both the CLI script
 * and the Heimdall refresh API route.
 */

import { PrismaClient, Prisma } from '@/src/generated/prisma/client';
import fs from 'fs';
import path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'debugging', 'logs');

// Default hosts per environment (can be overridden via options)
// Portal hosts come from env only (STREAMLINE_HOST or STREAMLINE_PORTAL_<NAME>_HOST),
// never from defaults in code.
function legacyHost(source: Record<string, string | undefined> = process.env): string {
  const host = source.STREAMLINE_HOST?.trim();
  if (!host) {
    throw new Error('Set STREAMLINE_HOST (or STREAMLINE_PORTALS) to the Streamline portal host');
  }
  // The token is sent to this host, so only accept a bare hostname.
  if (!HOSTNAME_RE.test(host)) {
    throw new Error('STREAMLINE_HOST must be a bare hostname (no scheme, port or path)');
  }
  return host;
}

export type StreamlinePortal = {
  name: string;
  environment: string;
  host: string;
  token: string | undefined;
  /** Custom-objects API that exposes get_all (default rest_test; some portals use rest_api). */
  apiName: string;
};

const DEFAULT_API_NAME = 'rest_test';
const API_NAME_RE = /^[a-z0-9_-]+$/i;

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Streamline portals to pull logs from.
 *
 * STREAMLINE_PORTALS (comma-separated names) lists several portals, each read
 * from STREAMLINE_PORTAL_<NAME>_HOST (required), _TOKEN, _ENV (default
 * "production") and _API (default "rest_test"). Without it, the single legacy portal from STREAMLINE_HOST,
 * STREAMLINE_ENV and STREAMLINE_TOKEN is used.
 */
export function getStreamlinePortals(source: Record<string, string | undefined> = process.env): StreamlinePortal[] {
  const names = (source.STREAMLINE_PORTALS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (names.length === 0) {
    const environment = source.STREAMLINE_ENV || 'staging';
    return [{ name: environment, environment, host: legacyHost(source), token: source.STREAMLINE_TOKEN, apiName: DEFAULT_API_NAME }];
  }

  return names.map((name) => {
    const prefix = `STREAMLINE_PORTAL_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const host = source[`${prefix}_HOST`]?.trim();
    if (!host) {
      throw new Error(`Streamline portal "${name}" is listed in STREAMLINE_PORTALS but ${prefix}_HOST is not set`);
    }
    // The token is sent to this host, so only accept a bare hostname.
    if (!HOSTNAME_RE.test(host)) {
      throw new Error(`${prefix}_HOST must be a bare hostname (no scheme, port or path)`);
    }
    const apiName = source[`${prefix}_API`]?.trim() || DEFAULT_API_NAME;
    if (!API_NAME_RE.test(apiName)) {
      throw new Error(`${prefix}_API must be a single API name such as rest_api`);
    }
    return {
      name,
      environment: source[`${prefix}_ENV`]?.trim() || 'production',
      host,
      token: source[`${prefix}_TOKEN`],
      apiName,
    };
  });
}

export type ImportResult = {
  mbuLogs: { created: number; skipped: number };
  serverSideRules: { created: number; skipped: number };
  traces: { created: number; skipped: number };
  filesProcessed: number;
  totalRecords: number;
  errors: string[];
};

// Derive model alias from filename when not in JSON
function deriveModelAlias(filePath: string): string {
  const fileName = path.basename(filePath);
  if (fileName.startsWith('mbu_logs')) return 'mbu_logs';
  if (fileName.startsWith('server_side_rules_log')) return 'server_side_rules_log';
  if (fileName.startsWith('traces')) return 'traces';
  return 'unknown';
}

// Find log files matching patterns
function findLogFiles(): string[] {
  if (!fs.existsSync(LOGS_DIR)) return [];

  return fs.readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => /^(mbu_logs|server_side_rules_log|traces)(_errors|_exceptions)?_\d{8}_\d{6}\.json$/.test(f))
    .map((f) => path.join(LOGS_DIR, f));
}

// Parse a single Ansible JSON log file
function parseLogFile(filePath: string): { modelAlias: string; records: Record<string, unknown>[] } {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const records = raw.json?.data?.records || [];
  const modelAlias = raw.json?.data?.model_alias || deriveModelAlias(filePath);

  return {
    modelAlias,
    records: records.map((r: unknown) => (typeof r === 'string' ? JSON.parse(r) : r)),
  };
}

// Transform MBU log record for DB
function transformMbuLog(record: Record<string, unknown>, env: string, host: string) {
  return {
    id: BigInt(record.id as string | number),
    createdAt: new Date(record.created_at as string),
    updatedAt: new Date(record.updated_at as string),
    backtrace: (record.backtrace as string) || '',
    logLevel: (record.log_level as string) || 'TRACE',
    traceType: (record.trace_type as string) || 'log',
    traceId: String(record.trace_id || ''),
    code: (record.code as string) || '',
    host,
    createdBy: record.created_by ? Number(record.created_by) : null,
    updatedBy: record.updated_by ? Number(record.updated_by) : null,
    environment: env,
  };
}

// Transform Server Side Rules log record for DB
function transformServerSideRulesLog(record: Record<string, unknown>, env: string, host: string) {
  return {
    id: BigInt(record.id as string | number),
    createdAt: new Date(record.created_at as string),
    updatedAt: new Date(record.updated_at as string),
    actionName: (record.action_name as string) || '',
    status: (record.status as string) || 'unknown',
    scriptName: (record.script_name as string) || '',
    duration: new Prisma.Decimal(Number(record.duration ?? 0)),
    ramUsage: parseInt(record.ram_usage as string, 10) || 0,
    cpuUsage: parseInt(record.cpu_usage as string, 10) || 0,
    host,
    isError: Boolean(record.is_error) || /error|fail/i.test(String(record.status ?? "")),
    errorDescr: (record.error_descr as string) || null,
    processId: record.process_id ? Number(record.process_id) : null,
    requestId: (record.request_id as string) || null,
    threadId: record.thread_id ? BigInt(record.thread_id as string | number) : null,
    dbRequestsTime: record.db_requests_time != null
      ? new Prisma.Decimal(Number(record.db_requests_time))
      : null,
    coModel: (record.co_model as string) || null,
    coRecordId: record.co_record_id ? Number(record.co_record_id) : null,
    resType: (record.res_type as string) || null,
    environment: env,
  };
}

// Transform Trace log record for DB
function transformTraceLog(record: Record<string, unknown>, env: string, host: string) {
  return {
    id: BigInt(record.id as string | number),
    createdAt: new Date(record.created_at as string),
    updatedAt: new Date(record.updated_at as string),
    traceId: BigInt((record.trace_id ?? record.id) as string | number),
    traceType: (record.trace_type as string) || 'log',
    logLevel: (record.log_level as string) || 'INFO',
    backtrace: (record.backtrace as string) || '',
    code: (record.code as string) || null,
    context: (record.context as string) || null,
    host,
    resourceId: record.resource_id ? Number(record.resource_id) : null,
    resourceType: (record.resource_type as string) || null,
    resourcePath: (record.resource_path as string) || null,
    createdBy: record.created_by ? Number(record.created_by) : null,
    updatedBy: record.updated_by ? Number(record.updated_by) : null,
    environment: env,
  };
}

/**
 * Drop records created before the retention cutoff. The log poller prunes
 * those, so importing them only deletes and re-inserts them every poll.
 * Records without a parseable created_at are kept.
 */
export function filterWithinRetention<T extends Record<string, unknown>>(
  records: T[],
  cutoff: Date,
): { kept: T[]; dropped: number } {
  const kept = records.filter((record) => {
    const createdAt = new Date(record.created_at as string).getTime();
    return Number.isNaN(createdAt) || createdAt >= cutoff.getTime();
  });
  return { kept, dropped: records.length - kept.length };
}

// Upsert a single MBU log record
export async function upsertMbuLog(
  prisma: PrismaClient,
  record: Record<string, unknown>,
  env: string,
  host: string,
): Promise<{ created: boolean }> {
  const data = transformMbuLog(record, env, host);
  const where = { id_environment_host: { id: data.id, environment: env, host } };
  try {
    // Upsert alone can't tell a new row from a refreshed one.
    const existing = await prisma.mbuLog.findUnique({ where, select: { id: true } });
    await prisma.mbuLog.upsert({ where, create: data, update: data });
    return { created: !existing };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { created: false };
    }
    throw err;
  }
}

// Upsert a single Server Side Rules log record
export async function upsertServerSideRulesLog(
  prisma: PrismaClient,
  record: Record<string, unknown>,
  env: string,
  host: string,
): Promise<{ created: boolean }> {
  const data = transformServerSideRulesLog(record, env, host);
  const where = { id_environment_host: { id: data.id, environment: env, host } };
  try {
    // Upsert alone can't tell a new row from a refreshed one.
    const existing = await prisma.serverSideRulesLog.findUnique({ where, select: { id: true } });
    await prisma.serverSideRulesLog.upsert({ where, create: data, update: data });
    return { created: !existing };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { created: false };
    }
    throw err;
  }
}

// Upsert a single Trace record
export async function upsertTrace(
  prisma: PrismaClient,
  record: Record<string, unknown>,
  env: string,
  host: string,
): Promise<{ created: boolean }> {
  const data = transformTraceLog(record, env, host);
  const where = { id_environment_host: { id: data.id, environment: env, host } };
  try {
    // Upsert alone can't tell a new row from a refreshed one.
    const existing = await prisma.trace.findUnique({ where, select: { id: true } });
    await prisma.trace.upsert({ where, create: data, update: data });
    return { created: !existing };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { created: false };
    }
    throw err;
  }
}

// Prisma's generated per-model upsert() signatures are structurally
// incompatible with each other (each model's WhereUniqueInput union
// requires a different set of alternate keys), so this can't be typed
// against the real delegate shape without a generic per-call-site cast.
// Record<string, unknown> args is the practical common denominator —
// the actual where/create/update objects are still fully typed at each
// call site below, this just describes what upsertRecords needs to call.
interface UpsertableModel {
  findUnique(args: Record<string, unknown>): Promise<unknown>;
  upsert(args: Record<string, unknown>): Promise<unknown>;
}

// Upsert records (skip if already exists by id + environment + host)
async function upsertRecords(
  model: UpsertableModel,
  records: Record<string, unknown>[],
  transformFn: (r: Record<string, unknown>, env: string, host: string) => Record<string, unknown>,
  env: string,
  host: string,
): Promise<{ created: number; skipped: number }> {
  let created = 0;
  let skipped = 0;

  for (const record of records) {
    const data = transformFn(record, env, host);

    const where = { id_environment_host: { id: data.id, environment: env, host } };
    try {
      const existing = await model.findUnique({ where, select: { id: true } });
      await model.upsert({ where, create: data, update: data });
      if (existing) skipped++;
      else created++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  return { created, skipped };
}

/** Newest id already stored (or fetched) per model; fetching stops once it is reached. */
export type StreamlineAfterIds = { mbuLogs?: bigint; serverSideRules?: bigint; traces?: bigint };

// Safety cap on pages per model per poll, so a long outage or a wrong
// newest-stored id can't turn one poll into an unbounded crawl.
const DEFAULT_MAX_PAGES = 20;

function isAfterId(record: Record<string, unknown>, afterId: bigint): boolean {
  try {
    return BigInt(record.id as string | number) > afterId;
  } catch {
    // Unparseable id: keep it, as before, and let the upsert decide.
    return true;
  }
}

/**
 * Fetch logs directly from Streamline API.
 * Returns raw records from the API for each log type.
 */
export async function fetchStreamlineLogsFromAPI(
  options: {
    environment?: string;
    limit?: number;
    host?: string;
    token?: string;
    apiName?: string;
    afterIds?: StreamlineAfterIds;
    maxPages?: number;
  } = {},
): Promise<{ mbuLogs: Record<string, unknown>[]; serverSideRules: Record<string, unknown>[]; traces: Record<string, unknown>[]; errors: string[]; host: string; capped: string[] }> {
  const limit = options.limit || 100;
  const host = options.host || legacyHost();
  const apiName = options.apiName || DEFAULT_API_NAME;
  const maxPages = options.maxPages || DEFAULT_MAX_PAGES;
  
  const result = {
    mbuLogs: [] as Record<string, unknown>[],
    serverSideRules: [] as Record<string, unknown>[],
    traces: [] as Record<string, unknown>[],
    errors: [] as string[],
    host,
    // Models whose newest-stored id was not reached within maxPages: older
    // records written since the last poll were not fetched.
    capped: [] as string[],
  };

  // Per-portal token, else the legacy STREAMLINE_TOKEN
  const token = options.token ?? process.env.STREAMLINE_TOKEN;
  if (!token) {
    result.errors.push(`Streamline token not configured for ${host}`);
    return result;
  }

  const apiBase = `https://${host}`;
  
  // Model aliases to fetch
  const modelAliases = [
    { alias: 'mbu_logs', key: 'mbuLogs' },
    { alias: 'server_side_rules_log', key: 'serverSideRules' },
    { alias: 'traces', key: 'traces' },
  ] as const;

  for (const model of modelAliases) {
    // Newest first. With a known newest-stored id, keep paging back until it
    // is reached so a gap between polls (restart, outage) loses nothing.
    // Without one (first poll for this portal) take a single page.
    const afterId = options.afterIds?.[model.key];
    const collected: Record<string, unknown>[] = [];
    try {
      for (let page = 0; ; page++) {
        const url = `${apiBase}/api/v1/custom_objects/${apiName}/get_all?token=${token}&model_alias=${model.alias}&order_by=id&order=DESC&limit=${limit}&offset=${page * limit}`;
        const res = await fetch(url, { method: 'GET' });

        if (!res.ok) {
          result.errors.push(`HTTP ${res.status} from ${model.alias}`);
          break;
        }

        const data = await res.json();
        // The API reports some failures (e.g. limit over 1000) as HTTP 200.
        if (data?.success === false) {
          result.errors.push(`${model.alias}: ${data?.error?.message || data?.message || 'request failed'}`);
          break;
        }
        const records = data?.data?.records || [];
        if (!Array.isArray(records)) break;

        // Parse each record (they come as JSON strings)
        const parsed: Record<string, unknown>[] = records.map((r: unknown) => {
          if (typeof r === 'string') {
            try {
              return JSON.parse(r);
            } catch {
              return { raw: r };
            }
          }
          return r as Record<string, unknown>;
        });

        if (afterId === undefined) {
          collected.push(...parsed);
          break;
        }
        const fresh = parsed.filter((r) => isAfterId(r, afterId));
        collected.push(...fresh);
        if (fresh.length < parsed.length || parsed.length < limit) break;
        if (page + 1 >= maxPages) {
          result.capped.push(model.alias);
          break;
        }
      }
    } catch (err) {
      result.errors.push(`Failed to fetch ${model.alias}: ${err instanceof Error ? err.message : String(err)}`);
    }
    result[model.key] = collected;
  }

  // If API didn't work, fall back to local files.
  // With an afterId, an empty result only means nothing is newer than it.
  const resumed = options.afterIds?.mbuLogs !== undefined || options.afterIds?.traces !== undefined;
  if (!resumed && result.mbuLogs.length === 0 && result.traces.length === 0) {
    result.errors.push('API fetch failed, no records returned');
  }

  return result;
}

/**
 * Import all available log files from debugging/logs/ into Supabase.
 * Uses upsert so existing records (by id + environment + host) are skipped.
 */
export async function importStreamlineLogs(
  prisma: PrismaClient,
  options: { environment?: string; logFile?: string; limit?: number; host?: string } = {},
): Promise<ImportResult> {
  const env = options.environment || 'staging';
  const host = options.host || legacyHost();
  const result: ImportResult = {
    mbuLogs: { created: 0, skipped: 0 },
    serverSideRules: { created: 0, skipped: 0 },
    traces: { created: 0, skipped: 0 },
    filesProcessed: 0,
    totalRecords: 0,
    errors: [],
  };

  const files = options.logFile
    ? [path.isAbsolute(options.logFile) ? options.logFile : path.join(process.cwd(), options.logFile)]
    : findLogFiles();

  if (files.length === 0) {
    result.errors.push('No log files found in debugging/logs/. Run the Ansible playbook first.');
    return result;
  }

  for (const file of files) {
    try {
      const { modelAlias, records } = parseLogFile(file);
      if (records.length === 0) continue;

      // Apply guard limit: only process the last N records
      const limitedRecords = options.limit
        ? records.slice(-options.limit)
        : records;

      result.filesProcessed++;
      result.totalRecords += limitedRecords.length;

      switch (modelAlias) {
        case 'mbu_logs': {
          const r = await upsertRecords(prisma.mbuLog, limitedRecords, transformMbuLog, env, host);
          result.mbuLogs.created += r.created;
          result.mbuLogs.skipped += r.skipped;
          break;
        }
        case 'server_side_rules_log': {
          const r = await upsertRecords(prisma.serverSideRulesLog, limitedRecords, transformServerSideRulesLog, env, host);
          result.serverSideRules.created += r.created;
          result.serverSideRules.skipped += r.skipped;
          break;
        }
        case 'traces': {
          const r = await upsertRecords(prisma.trace, limitedRecords, transformTraceLog, env, host);
          result.traces.created += r.created;
          result.traces.skipped += r.skipped;
          break;
        }
        default:
          // skip unknown models
          break;
      }
    } catch (err) {
      result.errors.push(`Failed to process ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Import logs fetched directly from Streamline API into Supabase.
 * Uses the fetchStreamlineLogsFromAPI function first, then imports results.
 */
export async function importStreamlineLogsFromAPI(
  prisma: PrismaClient,
  options: { environment?: string; limit?: number; host?: string; token?: string; apiName?: string; notBefore?: Date } = {},
): Promise<ImportResult> {
  const env = options.environment || 'staging';
  const limit = options.limit || 100;
  const host = options.host || legacyHost();

  const result: ImportResult = {
    mbuLogs: { created: 0, skipped: 0 },
    serverSideRules: { created: 0, skipped: 0 },
    traces: { created: 0, skipped: 0 },
    filesProcessed: 0,
    totalRecords: 0,
    errors: [],
  };

  // Fetch from API
  const apiResult = await fetchStreamlineLogsFromAPI({ environment: env, limit, host, token: options.token, apiName: options.apiName });
  result.errors = apiResult.errors;

  if (options.notBefore) {
    const cutoff = options.notBefore;
    apiResult.mbuLogs = filterWithinRetention(apiResult.mbuLogs, cutoff).kept;
    apiResult.serverSideRules = filterWithinRetention(apiResult.serverSideRules, cutoff).kept;
    apiResult.traces = filterWithinRetention(apiResult.traces, cutoff).kept;
  }

  // Import each record type
  if (apiResult.mbuLogs.length > 0) {
    const r = await upsertRecords(prisma.mbuLog, apiResult.mbuLogs, transformMbuLog, env, host);
    result.mbuLogs.created = r.created;
    result.mbuLogs.skipped = r.skipped;
    result.filesProcessed++;
    result.totalRecords += apiResult.mbuLogs.length;
  }

  if (apiResult.serverSideRules.length > 0) {
    const r = await upsertRecords(prisma.serverSideRulesLog, apiResult.serverSideRules, transformServerSideRulesLog, env, host);
    result.serverSideRules.created = r.created;
    result.serverSideRules.skipped = r.skipped;
    result.filesProcessed++;
    result.totalRecords += apiResult.serverSideRules.length;
  }

  if (apiResult.traces.length > 0) {
    const r = await upsertRecords(prisma.trace, apiResult.traces, transformTraceLog, env, host);
    result.traces.created = r.created;
    result.traces.skipped = r.skipped;
    result.filesProcessed++;
    result.totalRecords += apiResult.traces.length;
  }

  return result;
}
