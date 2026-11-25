import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserId = vi.fn();
const mockUserFindUnique = vi.fn();
const mockImport = vi.fn();
const mockGetPortals = vi.fn();

vi.mock("@/src/lib/db", () => ({ prisma: { user: { findUnique: mockUserFindUnique } } }));
vi.mock("@/src/lib/auth", () => ({ getAuthenticatedUserId: mockGetUserId }));
vi.mock("@/src/lib/streamline-import", () => ({
  getStreamlinePortals: mockGetPortals,
  importStreamlineLogsFromAPI: mockImport,
}));

const SA = { name: "sa", environment: "production", host: "streamline-sa.example.com", token: "sa-token", apiName: "rest_test" };
const DRC = { name: "drc", environment: "production", host: "streamline-drc.example.com", token: "drc-token", apiName: "rest_api" };

function importResult(created: number, errors: string[] = []) {
  return {
    mbuLogs: { created, skipped: 1 },
    serverSideRules: { created: 0, skipped: 0 },
    traces: { created: 0, skipped: 2 },
    filesProcessed: 2,
    totalRecords: created + 3,
    errors,
  };
}

describe("POST /api/heimdall/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserId.mockResolvedValue("u1");
    mockUserFindUnique.mockResolvedValue({ id: "u1", emailOrUsername: "admin" });
  });

  it("imports from every configured portal and sums the results", async () => {
    mockGetPortals.mockReturnValue([SA, DRC]);
    mockImport.mockImplementation(async (_prisma: unknown, { host }: { host: string }) =>
      host === SA.host ? importResult(3) : importResult(4, ["HTTP 401 from traces"]),
    );
    const { POST } = await import("@/app/api/heimdall/refresh/route");

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockImport).toHaveBeenCalledWith(expect.anything(), { environment: "production", host: SA.host, token: "sa-token", apiName: "rest_test", limit: 50, notBefore: expect.any(Date) });
    expect(mockImport).toHaveBeenCalledWith(expect.anything(), { environment: "production", host: DRC.host, token: "drc-token", apiName: "rest_api", limit: 50, notBefore: expect.any(Date) });
    // Nothing older than the retention window (STREAMLINE_LOG_RETENTION_DAYS, default 7) is imported.
    const notBefore: Date = mockImport.mock.calls[0][1].notBefore;
    expect(Math.abs(Date.now() - 7 * 24 * 60 * 60 * 1000 - notBefore.getTime())).toBeLessThan(60_000);
    expect(body).toMatchObject({
      success: true,
      mbuLogs: { created: 7, skipped: 2 },
      traces: { created: 0, skipped: 4 },
      filesProcessed: 4,
      totalRecords: 13,
      errors: ["drc: HTTP 401 from traces"],
    });
  });

  it("reports a portal that throws without dropping the others", async () => {
    mockGetPortals.mockReturnValue([SA, DRC]);
    mockImport.mockImplementation(async (_prisma: unknown, { host }: { host: string }) => {
      if (host === SA.host) throw new Error("boom");
      return importResult(4);
    });
    const { POST } = await import("@/app/api/heimdall/refresh/route");

    const body = await (await POST()).json();

    expect(body.success).toBe(true);
    expect(body.mbuLogs.created).toBe(4);
    expect(body.errors).toEqual(["sa: boom"]);
  });

  it("rejects unauthenticated callers", async () => {
    mockGetUserId.mockResolvedValue(null);
    const { POST } = await import("@/app/api/heimdall/refresh/route");

    const res = await POST();

    expect(res.status).toBe(401);
    expect(mockImport).not.toHaveBeenCalled();
  });
});
