import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/src/generated/prisma/client";
import {
  fetchStreamlineLogsFromAPI,
  filterWithinRetention,
  getStreamlinePortals,
  importStreamlineLogsFromAPI,
  upsertMbuLog,
} from "@/src/lib/streamline-import";

describe("getStreamlinePortals", () => {
  it("falls back to the single STREAMLINE_HOST portal when STREAMLINE_PORTALS is unset", () => {
    expect(getStreamlinePortals({ STREAMLINE_ENV: "production", STREAMLINE_HOST: "streamline.example.com", STREAMLINE_TOKEN: "t0" })).toEqual([
      { name: "production", environment: "production", host: "streamline.example.com", token: "t0", apiName: "rest_test" },
    ]);
  });

  it("defaults the legacy portal to staging", () => {
    expect(getStreamlinePortals({ STREAMLINE_HOST: "streamline.staging.example.com" })).toEqual([
      { name: "staging", environment: "staging", host: "streamline.staging.example.com", token: undefined, apiName: "rest_test" },
    ]);
  });

  it("rejects the legacy portal without STREAMLINE_HOST instead of guessing a host", () => {
    expect(() => getStreamlinePortals({ STREAMLINE_ENV: "production", STREAMLINE_TOKEN: "t0" })).toThrow(/STREAMLINE_HOST/);
  });

  it("rejects a legacy STREAMLINE_HOST that is not a bare hostname", () => {
    expect(() => getStreamlinePortals({ STREAMLINE_HOST: "https://evil.example/x" })).toThrow(/STREAMLINE_HOST/);
  });

  it("reads each listed portal's host, token and environment", () => {
    const portals = getStreamlinePortals({
      STREAMLINE_PORTALS: "sa, drc",
      STREAMLINE_PORTAL_SA_HOST: "streamline-sa.example.com",
      STREAMLINE_PORTAL_SA_TOKEN: "sa-token",
      STREAMLINE_PORTAL_DRC_HOST: "streamline-drc.example.com",
      STREAMLINE_PORTAL_DRC_TOKEN: "drc-token",
      STREAMLINE_PORTAL_DRC_ENV: "staging",
      STREAMLINE_PORTAL_DRC_API: "rest_api",
      // Ignored once STREAMLINE_PORTALS is set.
      STREAMLINE_ENV: "staging",
      STREAMLINE_TOKEN: "legacy",
    });
    expect(portals).toEqual([
      { name: "sa", environment: "production", host: "streamline-sa.example.com", token: "sa-token", apiName: "rest_test" },
      { name: "drc", environment: "staging", host: "streamline-drc.example.com", token: "drc-token", apiName: "rest_api" },
    ]);
  });

  it("maps portal names with dashes to env keys with underscores", () => {
    const [portal] = getStreamlinePortals({
      STREAMLINE_PORTALS: "drc-prod",
      STREAMLINE_PORTAL_DRC_PROD_HOST: "streamline-drc.example.com",
    });
    expect(portal.host).toBe("streamline-drc.example.com");
  });

  it("rejects a listed portal without a host", () => {
    expect(() => getStreamlinePortals({ STREAMLINE_PORTALS: "drc" })).toThrow(/STREAMLINE_PORTAL_DRC_HOST/);
  });

  it("rejects an API name that is not a single path segment", () => {
    expect(() =>
      getStreamlinePortals({
        STREAMLINE_PORTALS: "drc",
        STREAMLINE_PORTAL_DRC_HOST: "streamline-drc.example.com",
        STREAMLINE_PORTAL_DRC_API: "../admin",
      }),
    ).toThrow(/STREAMLINE_PORTAL_DRC_API/);
  });

  it("rejects a host that is not a bare hostname", () => {
    expect(() =>
      getStreamlinePortals({ STREAMLINE_PORTALS: "drc", STREAMLINE_PORTAL_DRC_HOST: "https://evil.example/x" }),
    ).toThrow(/STREAMLINE_PORTAL_DRC_HOST/);
  });
});

describe("fetchStreamlineLogsFromAPI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the given portal host and token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: { records: [JSON.stringify({ id: 1 })] } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchStreamlineLogsFromAPI({
      environment: "production",
      host: "streamline-drc.example.com",
      token: "drc-token",
      apiName: "rest_api",
      limit: 5,
    });

    expect(result.host).toBe("streamline-drc.example.com");
    expect(result.errors).toEqual([]);
    expect(result.mbuLogs).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls as unknown as [string][]) {
      const parsed = new URL(url);
      expect(parsed.host).toBe("streamline-drc.example.com");
      expect(parsed.pathname).toBe("/api/v1/custom_objects/rest_api/get_all");
      expect(parsed.searchParams.get("token")).toBe("drc-token");
      expect(parsed.searchParams.get("limit")).toBe("5");
    }
  });

  it("reports a missing token without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchStreamlineLogsFromAPI({ host: "streamline-drc.example.com", token: "" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.errors[0]).toMatch(/token not configured/i);
  });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const recent = (id: number) => ({ id, created_at: new Date(NOW - DAY).toISOString(), updated_at: new Date(NOW - DAY).toISOString() });
const old = (id: number) => ({ id, created_at: new Date(NOW - 30 * DAY).toISOString(), updated_at: new Date(NOW - 30 * DAY).toISOString() });

function fakeModel(existingIds: number[]) {
  return {
    findUnique: vi.fn(async ({ where }: { where: { id_environment_host: { id: bigint } } }) =>
      existingIds.includes(Number(where.id_environment_host.id)) ? { id: where.id_environment_host.id } : null,
    ),
    upsert: vi.fn(async () => ({})),
  };
}

describe("filterWithinRetention", () => {
  it("drops records created before the cutoff and keeps the rest", () => {
    const cutoff = new Date(NOW - 7 * DAY);
    const unparseable = { id: 9, created_at: "not a date" };

    const { kept, dropped } = filterWithinRetention([recent(1), old(2), unparseable], cutoff);

    expect(kept).toEqual([recent(1), unparseable]);
    expect(dropped).toBe(1);
  });
});

describe("upsertMbuLog", () => {
  it("reports a new row as created", async () => {
    const mbuLog = fakeModel([]);

    const result = await upsertMbuLog({ mbuLog } as unknown as PrismaClient, recent(1), "production", "h.example.com");

    expect(result).toEqual({ created: true });
    expect(mbuLog.upsert).toHaveBeenCalledTimes(1);
  });

  it("reports a row that already existed as not created, and still refreshes it", async () => {
    const mbuLog = fakeModel([1]);

    const result = await upsertMbuLog({ mbuLog } as unknown as PrismaClient, recent(1), "production", "h.example.com");

    expect(result).toEqual({ created: false });
    expect(mbuLog.findUnique).toHaveBeenCalledWith({
      where: { id_environment_host: { id: BigInt(1), environment: "production", host: "h.example.com" } },
      select: { id: true },
    });
    expect(mbuLog.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("importStreamlineLogsFromAPI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips records older than notBefore and counts existing rows as skipped", async () => {
    const byAlias: Record<string, unknown[]> = {
      mbu_logs: [recent(1), recent(2), old(3)],
      server_side_rules_log: [],
      traces: [old(4)],
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const alias = new URL(url).searchParams.get("model_alias") ?? "";
      return new Response(JSON.stringify({ data: { records: byAlias[alias] } }), { status: 200 });
    }));
    const prisma = { mbuLog: fakeModel([2]), serverSideRulesLog: fakeModel([]), trace: fakeModel([]) };

    const result = await importStreamlineLogsFromAPI(prisma as unknown as PrismaClient, {
      host: "h.example.com",
      token: "t",
      environment: "production",
      notBefore: new Date(NOW - 7 * DAY),
    });

    expect(result.mbuLogs).toEqual({ created: 1, skipped: 1 });
    expect(result.traces).toEqual({ created: 0, skipped: 0 });
    expect(prisma.mbuLog.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.trace.upsert).not.toHaveBeenCalled();
  });
});

describe("fetchStreamlineLogsFromAPI paging", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Serves ids newest-first like the real API: order_by=id&order=DESC&limit&offset.
  function stubPagedApi(idsByAlias: Record<string, number[]>) {
    const fetchMock = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      const ids = [...(idsByAlias[q.get("model_alias") ?? ""] ?? [])].sort((a, b) => b - a);
      const offset = Number(q.get("offset") ?? 0);
      const limit = Number(q.get("limit"));
      const page = ids.slice(offset, offset + limit).map((id) => JSON.stringify({ id }));
      return new Response(JSON.stringify({ success: true, data: { records: page } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const ids = (records: Record<string, unknown>[]) => records.map((r) => Number(r.id));
  const offsetsFor = (fetchMock: ReturnType<typeof stubPagedApi>, alias: string) =>
    (fetchMock.mock.calls as unknown as [string][])
      .map(([url]) => new URL(url).searchParams)
      .filter((q) => q.get("model_alias") === alias)
      .map((q) => Number(q.get("offset")));

  it("pages back until it reaches the newest stored id", async () => {
    const fetchMock = stubPagedApi({ server_side_rules_log: range(1, 25) });

    const result = await fetchStreamlineLogsFromAPI({
      host: "h.example.com",
      token: "t",
      limit: 5,
      afterIds: { serverSideRules: BigInt(12) },
    });

    expect(ids(result.serverSideRules)).toEqual(range(13, 25).reverse());
    expect(offsetsFor(fetchMock, "server_side_rules_log")).toEqual([0, 5, 10]);
    expect(result.capped).toEqual([]);
  });

  it("fetches a single page when nothing is stored yet", async () => {
    const fetchMock = stubPagedApi({ server_side_rules_log: range(1, 25) });

    const result = await fetchStreamlineLogsFromAPI({ host: "h.example.com", token: "t", limit: 5 });

    expect(ids(result.serverSideRules)).toEqual(range(21, 25).reverse());
    expect(offsetsFor(fetchMock, "server_side_rules_log")).toEqual([0]);
  });

  it("stops at a short page", async () => {
    const fetchMock = stubPagedApi({ mbu_logs: range(1, 7) });

    const result = await fetchStreamlineLogsFromAPI({ host: "h.example.com", token: "t", limit: 5, afterIds: { mbuLogs: BigInt(0) } });

    expect(ids(result.mbuLogs)).toEqual(range(1, 7).reverse());
    expect(offsetsFor(fetchMock, "mbu_logs")).toEqual([0, 5]);
  });

  it("stops at maxPages and reports the model as capped", async () => {
    const fetchMock = stubPagedApi({ server_side_rules_log: range(1, 100) });

    const result = await fetchStreamlineLogsFromAPI({
      host: "h.example.com",
      token: "t",
      limit: 5,
      maxPages: 3,
      afterIds: { serverSideRules: BigInt(10) },
    });

    expect(ids(result.serverSideRules)).toEqual(range(86, 100).reverse());
    expect(offsetsFor(fetchMock, "server_side_rules_log")).toEqual([0, 5, 10]);
    expect(result.capped).toEqual(["server_side_rules_log"]);
  });

  it("treats a 200 response with success: false as an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({ success: false, message: "Failed to retrieve records", error: { message: "limit must not exceed 1000" } }),
        { status: 200 },
      ),
    ));

    const result = await fetchStreamlineLogsFromAPI({ host: "h.example.com", token: "t", limit: 2000 });

    expect(result.mbuLogs).toEqual([]);
    expect(result.errors).toContain("mbu_logs: limit must not exceed 1000");
  });

  it("does not report an error when nothing is newer than the given ids", async () => {
    stubPagedApi({ mbu_logs: range(1, 9), traces: range(1, 4) });

    const result = await fetchStreamlineLogsFromAPI({
      host: "h.example.com",
      token: "t",
      limit: 5,
      afterIds: { mbuLogs: BigInt(9), traces: BigInt(4) },
    });

    expect(result.mbuLogs).toEqual([]);
    expect(result.traces).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("still reports a first fetch that returns nothing", async () => {
    stubPagedApi({});

    const result = await fetchStreamlineLogsFromAPI({ host: "h.example.com", token: "t", limit: 5 });

    expect(result.errors).toEqual(["API fetch failed, no records returned"]);
  });
});
