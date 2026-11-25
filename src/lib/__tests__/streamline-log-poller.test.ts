import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchLogs = vi.fn();
const mockUpsertMbuLog = vi.fn();
const mockGetPortals = vi.fn();
const mockLogEvent = vi.fn();

const mockMbuFindFirst = vi.fn(async () => null);
const mockSsrFindFirst = vi.fn(async () => null);
const mockTraceFindFirst = vi.fn(async () => null);

vi.mock("@/src/lib/db", () => ({
  prisma: {
    mbuLog: { deleteMany: vi.fn(async () => ({ count: 0 })), findFirst: mockMbuFindFirst },
    serverSideRulesLog: { deleteMany: vi.fn(async () => ({ count: 0 })), findFirst: mockSsrFindFirst },
    trace: { deleteMany: vi.fn(async () => ({ count: 0 })), findFirst: mockTraceFindFirst },
  },
}));
vi.mock("@/src/lib/env", () => ({
  env: {
    enableStreamlineLogPoller: true,
    streamlineLogPollIntervalMs: 60_000,
    streamlineLogLockTtlMs: 90_000,
    streamlineLogFetchLimit: 10,
    streamlineLogRetentionMs: 7 * 24 * 60 * 60 * 1000,
  },
}));
vi.mock("@/src/lib/log", () => ({ logEvent: mockLogEvent }));
vi.mock("@/src/lib/leader-lock", () => ({ acquireLeaderLock: vi.fn(async () => true) }));
vi.mock("@/src/lib/streamline-import", async (importOriginal) => ({
  filterWithinRetention: (await importOriginal<typeof import("@/src/lib/streamline-import")>()).filterWithinRetention,
  getStreamlinePortals: mockGetPortals,
  fetchStreamlineLogsFromAPI: mockFetchLogs,
  upsertMbuLog: mockUpsertMbuLog,
  upsertServerSideRulesLog: vi.fn(),
  upsertTrace: vi.fn(),
}));

const SA = { name: "sa", environment: "production", host: "streamline-sa.example.com", token: "sa-token", apiName: "rest_test" };
const DRC = { name: "drc", environment: "production", host: "streamline-drc.example.com", token: "drc-token", apiName: "rest_api" };

async function runOneTick() {
  vi.resetModules();
  globalThis.__streamline_log_poller_started__ = undefined;
  const { ensureStreamlineLogPollerStarted } = await import("@/src/lib/streamline-log-poller");
  ensureStreamlineLogPollerStarted();
  await vi.waitFor(() => {
    const done = mockLogEvent.mock.calls.some(([event]) =>
      event === "streamline_log_poller.tick.completed" || event === "streamline_log_poller.tick.failed",
    );
    expect(done).toBe(true);
  });
}

function eventsNamed(name: string) {
  return mockLogEvent.mock.calls.filter(([event]) => event === name).map(([, ctx, level]) => ({ ctx, level }));
}

describe("streamline log poller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mockUpsertMbuLog.mockResolvedValue({ created: true });
  });

  it("fetches and stores logs from every configured portal under its own host", async () => {
    mockGetPortals.mockReturnValue([SA, DRC]);
    mockFetchLogs.mockImplementation(async ({ host }: { host: string }) => ({
      mbuLogs: [{ id: host === SA.host ? 1 : 2 }],
      serverSideRules: [],
      traces: [],
      errors: [],
      host,
      capped: [],
    }));

    await runOneTick();

    expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ environment: "production", host: SA.host, token: "sa-token", apiName: "rest_test", limit: 10 }));
    expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({ environment: "production", host: DRC.host, token: "drc-token", apiName: "rest_api", limit: 10 }));
    expect(mockUpsertMbuLog).toHaveBeenCalledWith(expect.anything(), { id: 1 }, "production", SA.host);
    expect(mockUpsertMbuLog).toHaveBeenCalledWith(expect.anything(), { id: 2 }, "production", DRC.host);
    const portals = eventsNamed("streamline_log_poller.portal.completed").map(({ ctx }) => ctx.portal);
    expect(portals).toEqual(["sa", "drc"]);
  });

  it("keeps polling the other portals when one fails", async () => {
    mockGetPortals.mockReturnValue([SA, DRC]);
    mockFetchLogs.mockImplementation(async ({ host }: { host: string }) => {
      if (host === SA.host) throw new Error("boom");
      return { mbuLogs: [{ id: 2 }], serverSideRules: [], traces: [], errors: [], host, capped: [] };
    });

    await runOneTick();

    expect(eventsNamed("streamline_log_poller.portal.failed")).toEqual([
      { ctx: expect.objectContaining({ portal: "sa", error: "boom" }), level: "error" },
    ]);
    expect(mockUpsertMbuLog).toHaveBeenCalledWith(expect.anything(), { id: 2 }, "production", DRC.host);
  });

  it("fails the tick clearly when the portal config is invalid", async () => {
    mockGetPortals.mockImplementation(() => {
      throw new Error("STREAMLINE_PORTAL_DRC_HOST is not set");
    });

    await runOneTick();

    expect(mockFetchLogs).not.toHaveBeenCalled();
    expect(eventsNamed("streamline_log_poller.tick.failed")).toEqual([
      { ctx: expect.objectContaining({ error: "STREAMLINE_PORTAL_DRC_HOST is not set" }), level: "error" },
    ]);
  });
});

describe("streamline log poller retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mockUpsertMbuLog.mockResolvedValue({ created: true });
  });

  it("does not re-import records the prune step would delete again", async () => {
    const day = 24 * 60 * 60 * 1000;
    const fresh = { id: 1, created_at: new Date(Date.now() - day).toISOString() };
    const expired = { id: 2, created_at: new Date(Date.now() - 30 * day).toISOString() };
    mockGetPortals.mockReturnValue([DRC]);
    mockFetchLogs.mockResolvedValue({ mbuLogs: [fresh, expired], serverSideRules: [], traces: [], errors: [], host: DRC.host, capped: [] });

    await runOneTick();

    expect(mockUpsertMbuLog).toHaveBeenCalledTimes(1);
    expect(mockUpsertMbuLog).toHaveBeenCalledWith(expect.anything(), fresh, "production", DRC.host);
    const [done] = eventsNamed("streamline_log_poller.portal.completed");
    expect(done.ctx).toMatchObject({ portal: "drc", totalRecords: 1, droppedExpired: 1 });
  });
});

describe("streamline log poller paging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mockUpsertMbuLog.mockResolvedValue({ created: true });
    mockGetPortals.mockReturnValue([DRC]);
  });

  it("fetches from the newest id already stored for each model of the portal", async () => {
    mockSsrFindFirst.mockResolvedValue({ id: BigInt(7973050) } as never);
    mockFetchLogs.mockResolvedValue({ mbuLogs: [], serverSideRules: [], traces: [], errors: [], host: DRC.host, capped: [] });

    await runOneTick();

    expect(mockSsrFindFirst).toHaveBeenCalledWith({
      where: { environment: "production", host: DRC.host },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    expect(mockFetchLogs).toHaveBeenCalledWith(expect.objectContaining({
      host: DRC.host,
      afterIds: { mbuLogs: undefined, serverSideRules: BigInt(7973050), traces: undefined },
    }));
  });

  it("warns when a model hit the page cap, since older records may be missing", async () => {
    mockFetchLogs.mockResolvedValue({
      mbuLogs: [], serverSideRules: [], traces: [], errors: [], host: DRC.host, capped: ["server_side_rules_log"],
    });

    await runOneTick();

    expect(eventsNamed("streamline_log_poller.portal.fetch_capped")).toEqual([
      { ctx: expect.objectContaining({ portal: "drc", models: ["server_side_rules_log"] }), level: "warn" },
    ]);
  });
});

describe("streamline log poller with nothing stored for a model", () => {
  const day = 24 * 60 * 60 * 1000;
  const expired = (id: number) => ({ id, created_at: new Date(Date.now() - 30 * day).toISOString() });
  const fresh = (id: number) => ({ id, created_at: new Date(Date.now() - day).toISOString() });
  const empty = { mbuLogs: [], serverSideRules: [], traces: [], errors: [], host: DRC.host, capped: [] };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["setInterval"] });
    mockUpsertMbuLog.mockResolvedValue({ created: true });
    mockGetPortals.mockReturnValue([DRC]);
    mockMbuFindFirst.mockResolvedValue(null);
    mockSsrFindFirst.mockResolvedValue(null);
    mockTraceFindFirst.mockResolvedValue(null);
  });

  // Runs the first tick, then the next interval tick in the same module instance.
  async function runTwoTicks() {
    await runOneTick();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => {
      const done = mockLogEvent.mock.calls.filter(([event]) =>
        event === "streamline_log_poller.tick.completed" || event === "streamline_log_poller.tick.failed",
      );
      expect(done).toHaveLength(2);
    });
  }

  it("fetches from the newest id it already dropped as expired instead of refetching it", async () => {
    mockFetchLogs
      .mockResolvedValueOnce({ ...empty, mbuLogs: [expired(9), expired(8)], traces: [expired(5), expired(4)] })
      .mockResolvedValueOnce(empty);

    await runTwoTicks();

    expect(mockFetchLogs).toHaveBeenCalledTimes(2);
    expect(mockFetchLogs.mock.calls[1][0].afterIds).toEqual({ mbuLogs: BigInt(9), serverSideRules: undefined, traces: BigInt(5) });
    const completed = eventsNamed("streamline_log_poller.portal.completed").map(({ ctx }) => ctx.droppedExpired);
    expect(completed).toEqual([4, 0]);
  });

  it("prefers the newest stored id when it is newer than the newest fetched one", async () => {
    mockFetchLogs.mockResolvedValueOnce({ ...empty, traces: [expired(5)] }).mockResolvedValueOnce(empty);
    mockTraceFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: BigInt(12) } as never);

    await runTwoTicks();

    expect(mockFetchLogs.mock.calls[1][0].afterIds).toMatchObject({ traces: BigInt(12) });
  });

  it("does not skip past records whose import failed", async () => {
    mockFetchLogs.mockResolvedValueOnce({ ...empty, mbuLogs: [fresh(9)] }).mockResolvedValueOnce(empty);
    mockUpsertMbuLog.mockRejectedValueOnce(new Error("db down"));

    await runTwoTicks();

    expect(eventsNamed("streamline_log_poller.portal.failed")).toHaveLength(1);
    expect(mockFetchLogs.mock.calls[1][0].afterIds).toMatchObject({ mbuLogs: undefined });
  });
});
