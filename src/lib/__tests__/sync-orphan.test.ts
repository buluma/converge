import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockSyncJobFindFirst,
  mockSyncJobFindUnique,
  mockSyncJobCreate,
  mockSyncJobUpdate,
  mockSyncStateUpsert,
  mockSyncStateUpdateMany,
  mockSyncStateFindUnique,
  mockSyncStateCreate,
  mockLeaderLockFindUnique,
  mockLeaderLockUpdateMany,
  mockLeaderLockCreate,
  mockLeaderLockDeleteMany,
  mockCredFindUnique,
} = vi.hoisted(() => ({
  mockSyncJobFindFirst: vi.fn(),
  mockSyncJobFindUnique: vi.fn(),
  mockSyncJobCreate: vi.fn(),
  mockSyncJobUpdate: vi.fn(),
  mockSyncStateUpsert: vi.fn(),
  mockSyncStateUpdateMany: vi.fn(),
  mockSyncStateFindUnique: vi.fn(),
  mockSyncStateCreate: vi.fn(),
  mockLeaderLockFindUnique: vi.fn(),
  mockLeaderLockUpdateMany: vi.fn(),
  mockLeaderLockCreate: vi.fn(),
  mockLeaderLockDeleteMany: vi.fn(),
  mockCredFindUnique: vi.fn(),
}));

vi.mock("@/src/lib/db", () => ({
  prisma: {
    syncJob: {
      findFirst: mockSyncJobFindFirst,
      findUnique: mockSyncJobFindUnique,
      create: mockSyncJobCreate,
      update: mockSyncJobUpdate,
    },
    syncState: {
      upsert: mockSyncStateUpsert,
      // getOrCreateSyncJob's atomic claim (SyncState.userId is a real
      // unique key) — always "wins" the claim in these tests so the
      // existing reuse/reset assertions below aren't affected by it.
      updateMany: mockSyncStateUpdateMany,
      findUnique: mockSyncStateFindUnique,
      create: mockSyncStateCreate,
    },
    // Running jobs hold a "sync-job:<id>" lease in LeaderLock while their
    // process is alive.
    leaderLock: {
      findUnique: mockLeaderLockFindUnique,
      updateMany: mockLeaderLockUpdateMany,
      create: mockLeaderLockCreate,
      deleteMany: mockLeaderLockDeleteMany,
    },
    userRedmineCredential: { findUnique: mockCredFindUnique },
  },
}));

vi.mock("@/src/lib/env", () => ({
  env: {
    syncJobStaleMs: 10 * 60 * 1000,
    syncJobRunningStaleMs: 2 * 60 * 60 * 1000,
    leaderLockTtlMs: 90 * 1000,
  },
}));

vi.mock("@/src/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/src/lib/event-bus", () => ({ emitEvent: vi.fn() }));
vi.mock("@/src/lib/telemetry", () => ({ trackFailure: vi.fn() }));
vi.mock("@/src/lib/redmine", () => ({ RedmineClient: vi.fn() }));
vi.mock("@/src/lib/activity-index", () => ({
  recordIssueActivityEvent: vi.fn(),
  recomputeIssueActivityIndex: vi.fn(),
}));

import { executeSyncJob, runSyncJob } from "@/src/lib/sync";

const USER_ID = "user-1";

function lease(jobId: string, expiresInMs: number) {
  const now = Date.now();
  return {
    name: `sync-job:${jobId}`,
    ownerId: "other-process",
    heartbeatAt: new Date(now - 1000),
    expiresAt: new Date(now + expiresInMs),
  };
}

describe("runSyncJob orphaned running jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // executeSyncJob (fired via void) bails out when the job is not found
    mockSyncJobFindUnique.mockResolvedValue(null);
    mockSyncJobUpdate.mockResolvedValue({});
    mockSyncStateUpsert.mockResolvedValue({});
    mockSyncStateUpdateMany.mockResolvedValue({ count: 1 }); // always wins the atomic claim
    mockSyncJobCreate.mockResolvedValue({
      id: "job-new",
      userId: USER_ID,
      jobType: "incremental",
      status: "pending",
    });
    mockLeaderLockFindUnique.mockResolvedValue(null);
    mockLeaderLockDeleteMany.mockResolvedValue({ count: 1 });
  });

  it("resets a running job whose process died and starts a new one", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    mockSyncJobFindFirst.mockResolvedValue({
      id: "job-orphan",
      userId: USER_ID,
      status: "running",
      createdAt: threeHoursAgo,
      startedAt: threeHoursAgo,
    });

    const result = await runSyncJob(USER_ID, "incremental");

    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-orphan" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mockSyncStateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastSyncStatus: "failed",
          runningJobId: null,
        }),
      }),
    );
    expect(mockSyncJobCreate).toHaveBeenCalled();
    expect(result.jobId).toBe("job-new");
  });

  it("resets a recent running job whose process holds no lease (restart mid-sync)", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    mockSyncJobFindFirst.mockResolvedValue({
      id: "job-restarted",
      userId: USER_ID,
      status: "running",
      createdAt: twoMinutesAgo,
      startedAt: twoMinutesAgo,
    });
    mockLeaderLockFindUnique.mockResolvedValue(null);

    const result = await runSyncJob(USER_ID, "incremental");

    expect(mockLeaderLockFindUnique).toHaveBeenCalledWith({ where: { name: "sync-job:job-restarted" } });
    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-restarted" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mockSyncJobCreate).toHaveBeenCalled();
    expect(result.jobId).toBe("job-new");
  });

  it("resets a recent running job whose lease expired and removes the stale lease", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    mockSyncJobFindFirst.mockResolvedValue({
      id: "job-dead",
      userId: USER_ID,
      status: "running",
      createdAt: twoMinutesAgo,
      startedAt: twoMinutesAgo,
    });
    mockLeaderLockFindUnique.mockResolvedValue(lease("job-dead", -5000));

    const result = await runSyncJob(USER_ID, "incremental");

    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "job-dead" },
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mockLeaderLockDeleteMany).toHaveBeenCalledWith({ where: { name: "sync-job:job-dead" } });
    expect(result.jobId).toBe("job-new");
  });

  it("reuses a running job that is still within the running-stale window", async () => {
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    mockSyncJobFindFirst.mockResolvedValue({
      id: "job-live",
      userId: USER_ID,
      status: "running",
      createdAt: oneMinuteAgo,
      startedAt: oneMinuteAgo,
    });
    mockLeaderLockFindUnique.mockResolvedValue(lease("job-live", 60 * 1000));

    const result = await runSyncJob(USER_ID, "incremental");

    expect(result.jobId).toBe("job-live");
    expect(mockSyncJobCreate).not.toHaveBeenCalled();
    expect(mockSyncJobUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});

describe("runSyncJob concurrent-caller dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncJobFindUnique.mockResolvedValue(null);
    mockSyncJobUpdate.mockResolvedValue({});
    mockSyncStateUpsert.mockResolvedValue({});
    // Both callers' findFirst races before either has created a job yet.
    mockSyncJobFindFirst.mockResolvedValue(null);
  });

  it("only creates one SyncJob when two callers race findFirst→create with nothing existing yet", async () => {
    // Both callers' very first findFirst — before either has created
    // anything — sees no job at all. This is the actual race: without the
    // atomic claim, both would fall straight through to create().
    // Call order (A runs to completion before B starts, so it's
    // deterministic): 1) A's initial findFirst, 2) B's initial findFirst,
    // 3) B's fallback lookup after it loses the claim — by which point A's
    // job genuinely exists.
    const winnerJob = { id: "job-winner", userId: USER_ID, status: "pending", createdAt: new Date() };
    mockSyncJobFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winnerJob);

    // Simulates the real DB: userId is SyncState's unique key, so only the
    // first updateMany actually matches a row (or, for a first-ever sync,
    // only the first create succeeds and the second hits SyncState's real
    // unique constraint) — here that's the first call in program order.
    mockSyncStateUpdateMany
      .mockResolvedValueOnce({ count: 1 }) // caller A claims it
      .mockResolvedValueOnce({ count: 0 }); // caller B loses the claim
    mockSyncStateFindUnique.mockResolvedValue({ userId: USER_ID, lastSyncStatus: "pending" });
    mockSyncJobCreate.mockResolvedValue({ id: "job-winner", userId: USER_ID, jobType: "incremental", status: "pending" });

    const resultA = await runSyncJob(USER_ID, "incremental");
    const resultB = await runSyncJob(USER_ID, "incremental");

    expect(mockSyncJobCreate).toHaveBeenCalledTimes(1);
    expect(resultA.jobId).toBe("job-winner");
    expect(resultB.jobId).toBe("job-winner");
  });
});

describe("executeSyncJob lease", () => {
  const pendingJob = { id: "job-1", userId: USER_ID, jobType: "incremental", status: "pending" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncJobFindUnique.mockResolvedValue(pendingJob);
    mockSyncJobUpdate.mockResolvedValue({});
    mockSyncStateUpsert.mockResolvedValue({});
    mockLeaderLockUpdateMany.mockResolvedValue({ count: 0 });
    mockLeaderLockCreate.mockResolvedValue({});
    mockLeaderLockDeleteMany.mockResolvedValue({ count: 1 });
    // No credential: the job fails fast after it has started running.
    mockCredFindUnique.mockResolvedValue(null);
  });

  it("takes the lease before marking the job running and releases it when done", async () => {
    await executeSyncJob("job-1");

    expect(mockLeaderLockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "sync-job:job-1" }),
    });
    const runningCall = mockSyncJobUpdate.mock.calls.findIndex(([arg]) => arg.data.status === "running");
    expect(runningCall).toBeGreaterThanOrEqual(0);
    expect(mockLeaderLockCreate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncJobUpdate.mock.invocationCallOrder[runningCall],
    );
    expect(mockSyncJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "job-1" }, data: expect.objectContaining({ status: "failed" }) }),
    );
    expect(mockLeaderLockDeleteMany).toHaveBeenCalledWith({
      where: { name: "sync-job:job-1", ownerId: expect.any(String) },
    });
  });

  it("does not run a job whose lease another live process holds", async () => {
    mockLeaderLockCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    await executeSyncJob("job-1");

    expect(mockSyncJobUpdate).not.toHaveBeenCalled();
    expect(mockCredFindUnique).not.toHaveBeenCalled();
  });
});
