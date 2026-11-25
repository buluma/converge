/**
 * Streamline Log Poller
 *
 * Dedicated poller for auto-fetching logs from Streamline API into the database.
 * Uses leader lock pattern to ensure only one instance runs at a time.
 *
 * Architecture:
 * 1. Leader election via PostgreSQL lock (same as sync poller)
 * 2. Periodic fetch from each configured Streamline portal (see getStreamlinePortals)
 * 3. Upsert into DB (skips duplicates by id + environment + host)
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db";
import { env } from "@/src/lib/env";
import { logEvent } from "@/src/lib/log";
import { acquireLeaderLock } from "@/src/lib/leader-lock";
import {
  fetchStreamlineLogsFromAPI,
  filterWithinRetention,
  getStreamlinePortals,
  type StreamlineAfterIds,
  type StreamlinePortal,
  upsertMbuLog,
  upsertServerSideRulesLog,
  upsertTrace,
} from "@/src/lib/streamline-import";

declare global {
  var __streamline_log_poller_started__: boolean | undefined;
}

const LOCK_NAME = "streamline-log-poller";
const ownerId = randomUUID();
let intervalRef: NodeJS.Timeout | null = null;
let tickInFlight = false;

function retentionCutoff(): Date {
  return new Date(Date.now() - env.streamlineLogRetentionMs);
}

async function pruneOldLogs(): Promise<void> {
  const cutoff = retentionCutoff();
  const [mbu, ssr, traces] = await Promise.all([
    prisma.mbuLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.serverSideRulesLog.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.trace.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  const total = mbu.count + ssr.count + traces.count;
  if (total > 0) {
    logEvent("streamline_log_poller.pruned", { mbuLogs: mbu.count, serverSideRules: ssr.count, traces: traces.count });
  }
}

type PollStats = {
  mbuLogs: { created: number; skipped: number };
  serverSideRules: { created: number; skipped: number };
  traces: { created: number; skipped: number };
};

function emptyStats(): PollStats {
  return {
    mbuLogs: { created: 0, skipped: 0 },
    serverSideRules: { created: 0, skipped: 0 },
    traces: { created: 0, skipped: 0 },
  };
}

function addStats(total: PollStats, add: PollStats): void {
  for (const key of ["mbuLogs", "serverSideRules", "traces"] as const) {
    total[key].created += add[key].created;
    total[key].skipped += add[key].skipped;
  }
}

async function newestStoredIds(portal: StreamlinePortal): Promise<StreamlineAfterIds> {
  const query = {
    where: { environment: portal.environment, host: portal.host },
    orderBy: { id: "desc" as const },
    select: { id: true },
  };
  const [mbu, ssr, trace] = await Promise.all([
    prisma.mbuLog.findFirst(query),
    prisma.serverSideRulesLog.findFirst(query),
    prisma.trace.findFirst(query),
  ]);
  return { mbuLogs: mbu?.id, serverSideRules: ssr?.id, traces: trace?.id };
}

type LogModel = keyof StreamlineAfterIds;
const LOG_MODELS: LogModel[] = ["mbuLogs", "serverSideRules", "traces"];

// Newest id fetched per portal and model, whether stored or dropped as past
// retention. Once every stored row of a model is pruned there is no stored
// newest id, and without this each poll refetches and drops the same page.
// In memory only: after a restart or leader change the first poll refetches
// that page once.
const newestFetchedIds = new Map<string, bigint>();

function fetchedKey(portal: StreamlinePortal, model: LogModel): string {
  return `${portal.environment}|${portal.host}|${model}`;
}

function newestIdOf(records: Record<string, unknown>[]): bigint | undefined {
  let newest: bigint | undefined;
  for (const record of records) {
    let id: bigint;
    try {
      id = BigInt(record.id as string | number);
    } catch {
      continue;
    }
    if (newest === undefined || id > newest) newest = id;
  }
  return newest;
}

function withNewestFetched(portal: StreamlinePortal, stored: StreamlineAfterIds): StreamlineAfterIds {
  const afterIds = { ...stored };
  for (const model of LOG_MODELS) {
    const fetched = newestFetchedIds.get(fetchedKey(portal, model));
    if (fetched !== undefined && (afterIds[model] === undefined || fetched > afterIds[model])) {
      afterIds[model] = fetched;
    }
  }
  return afterIds;
}

async function pollPortal(
  portal: StreamlinePortal,
): Promise<{ totalRecords: number; stats: PollStats; errors: string[] }> {
  const startTime = Date.now();

  // Fetch everything newer than what is already stored (or fetched) for this portal, so a
  // gap between polls (restart, outage) doesn't drop records.
  const afterIds = withNewestFetched(portal, await newestStoredIds(portal));
  const apiResult = await fetchStreamlineLogsFromAPI({
    environment: portal.environment,
    host: portal.host,
    token: portal.token,
    apiName: portal.apiName,
    limit: env.streamlineLogFetchLimit,
    afterIds,
  });
  if (apiResult.capped.length > 0) {
    logEvent(
      "streamline_log_poller.portal.fetch_capped",
      { ownerId, portal: portal.name, host: portal.host, models: apiResult.capped },
      "warn",
    );
  }

  const fetchedNewest = {
    mbuLogs: newestIdOf(apiResult.mbuLogs),
    serverSideRules: newestIdOf(apiResult.serverSideRules),
    traces: newestIdOf(apiResult.traces),
  };

  // Skip records pruneOldLogs would delete again on the next tick.
  const cutoff = retentionCutoff();
  const mbuLogs = filterWithinRetention(apiResult.mbuLogs, cutoff);
  const serverSideRules = filterWithinRetention(apiResult.serverSideRules, cutoff);
  const traces = filterWithinRetention(apiResult.traces, cutoff);
  apiResult.mbuLogs = mbuLogs.kept;
  apiResult.serverSideRules = serverSideRules.kept;
  apiResult.traces = traces.kept;
  const droppedExpired = mbuLogs.dropped + serverSideRules.dropped + traces.dropped;

  let totalImported = 0;
  const stats = emptyStats();
  const { environment, host } = portal;

  // Import each log type
  if (apiResult.mbuLogs.length > 0) {
    for (const record of apiResult.mbuLogs) {
      const result = await upsertMbuLog(prisma, record, environment, host);
      if (result.created) stats.mbuLogs.created++;
      else stats.mbuLogs.skipped++;
    }
    totalImported += apiResult.mbuLogs.length;
  }

  if (apiResult.serverSideRules.length > 0) {
    for (const record of apiResult.serverSideRules) {
      const result = await upsertServerSideRulesLog(prisma, record, environment, host);
      if (result.created) stats.serverSideRules.created++;
      else stats.serverSideRules.skipped++;
    }
    totalImported += apiResult.serverSideRules.length;
  }

  if (apiResult.traces.length > 0) {
    for (const record of apiResult.traces) {
      const result = await upsertTrace(prisma, record, environment, host);
      if (result.created) stats.traces.created++;
      else stats.traces.skipped++;
    }
    totalImported += apiResult.traces.length;
  }

  // Only once every kept record is stored, so a failed import is retried.
  for (const model of LOG_MODELS) {
    const newest = fetchedNewest[model];
    if (newest !== undefined) newestFetchedIds.set(fetchedKey(portal, model), newest);
  }

  logEvent("streamline_log_poller.portal.completed", {
    ownerId,
    portal: portal.name,
    environment,
    host,
    durationMs: Date.now() - startTime,
    totalRecords: totalImported,
    droppedExpired,
    ...stats,
    errors: apiResult.errors,
  });

  return { totalRecords: totalImported, stats, errors: apiResult.errors };
}

async function pollTick(): Promise<void> {
  if (tickInFlight) {
    return;
  }

  tickInFlight = true;
  const startTime = Date.now();

  try {
    const isLeader = await acquireLeaderLock(LOCK_NAME, ownerId, env.streamlineLogLockTtlMs);
    if (!isLeader) {
      logEvent("streamline_log_poller.tick.skipped_not_leader", { ownerId });
      return;
    }

    await pruneOldLogs();

    const portals = getStreamlinePortals();

    logEvent("streamline_log_poller.tick.started", {
      ownerId,
      portals: portals.map((portal) => portal.name),
      limit: env.streamlineLogFetchLimit,
    });

    let totalImported = 0;
    const stats = emptyStats();
    const errors: string[] = [];

    // One portal failing (bad token, portal down) must not stop the others.
    for (const portal of portals) {
      try {
        const result = await pollPortal(portal);
        totalImported += result.totalRecords;
        addStats(stats, result.stats);
        errors.push(...result.errors.map((error) => `${portal.name}: ${error}`));
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        errors.push(`${portal.name}: ${err}`);
        logEvent(
          "streamline_log_poller.portal.failed",
          { ownerId, portal: portal.name, host: portal.host, error: err },
          "error",
        );
      }
    }

    const durationMs = Date.now() - startTime;

    logEvent("streamline_log_poller.tick.completed", {
      ownerId,
      durationMs,
      totalRecords: totalImported,
      ...stats,
      errors,
    });
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    logEvent("streamline_log_poller.tick.failed", { ownerId, error: err }, "error");
  } finally {
    tickInFlight = false;
  }
}

export function ensureStreamlineLogPollerStarted(): void {
  if (!env.enableStreamlineLogPoller) {
    logEvent("streamline_log_poller.disabled", { ownerId });
    return;
  }

  if (
    process.env.NEXT_PHASE === "phase-production-build" ||
    process.env.npm_lifecycle_event === "build"
  ) {
    return;
  }

  if (global.__streamline_log_poller_started__) {
    return;
  }

  global.__streamline_log_poller_started__ = true;

  logEvent("streamline_log_poller.starting", {
    ownerId,
    intervalMs: env.streamlineLogPollIntervalMs,
    lockTtlMs: env.streamlineLogLockTtlMs,
    fetchLimit: env.streamlineLogFetchLimit,
  });

  intervalRef = setInterval(() => {
    void pollTick();
  }, env.streamlineLogPollIntervalMs);

  if (intervalRef.unref) {
    intervalRef.unref();
  }

  // Run immediately on start
  void pollTick();
}
