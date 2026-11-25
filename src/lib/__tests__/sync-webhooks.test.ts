import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIssueFindFirst,
  mockIssueFindUnique,
  mockIssueUpsert,
  mockTimeEntryAggregate,
  mockIssueActivityEventFindFirst,
  mockStatusCatalogFindMany,
  mockDispatchWebhook,
  mockSendPushNotification,
  mockNotifyIssueChanges,
  mockWebhookEnv,
} = vi.hoisted(() => ({
  mockIssueFindFirst: vi.fn(),
  mockIssueFindUnique: vi.fn(),
  mockIssueUpsert: vi.fn(),
  mockTimeEntryAggregate: vi.fn(),
  mockIssueActivityEventFindFirst: vi.fn(),
  mockStatusCatalogFindMany: vi.fn(),
  mockDispatchWebhook: vi.fn(),
  mockSendPushNotification: vi.fn(),
  mockNotifyIssueChanges: vi.fn(),
  mockWebhookEnv: { webhookCompletedStatuses: ["Resolved"] as string[] },
}));

vi.mock("@/src/lib/db", () => ({
  prisma: {
    issue: { findFirst: mockIssueFindFirst, findUnique: mockIssueFindUnique, upsert: mockIssueUpsert, update: vi.fn() },
    issueJournal: { upsert: vi.fn() },
    issueAttachment: { deleteMany: vi.fn() },
    issueRelation: { deleteMany: vi.fn() },
    timeEntry: { upsert: vi.fn(), deleteMany: vi.fn(), aggregate: mockTimeEntryAggregate },
    issueActivityEvent: { upsert: vi.fn(), findFirst: mockIssueActivityEventFindFirst },
    statusCatalog: { findMany: mockStatusCatalogFindMany },
  },
}));

vi.mock("@/src/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/env")>();
  return {
    env: new Proxy(actual.env, {
      get: (target, key) => (key in mockWebhookEnv ? mockWebhookEnv[key as keyof typeof mockWebhookEnv] : Reflect.get(target, key)),
    }),
  };
});
vi.mock("@/src/lib/webhook-subscription", () => ({ dispatchWebhook: mockDispatchWebhook }));
vi.mock("@/src/lib/push", () => ({ sendPushNotification: mockSendPushNotification }));
vi.mock("@/src/lib/slack-notification-service", () => ({
  getSlackNotificationService: () => ({ toIssueState: (i: unknown) => i, notifyIssueChanges: mockNotifyIssueChanges }),
}));
vi.mock("@/src/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/src/lib/telemetry", () => ({ trackFailure: vi.fn() }));

import { syncSingleIssue } from "@/src/lib/sync/single-issue";

const USER_ID = "user-1";
const REMOTE_ISSUE_ID = 4321;

function fakeClient(statusName = "New", statusId = 2) {
  return {
    normalizedBaseUrl: "https://redmine.example.com",
    getIssue: vi.fn().mockResolvedValue({
      issue: {
        id: REMOTE_ISSUE_ID,
        subject: "Fix the DRC export",
        status: { id: statusId, name: statusName },
        priority: { id: 5, name: "High" },
        project: { id: 7, name: "Streamline" },
        updated_on: "2026-11-21T09:00:00Z",
      },
    }),
    listIssueTimeEntries: vi.fn().mockResolvedValue([]),
  } as unknown as Parameters<typeof syncSingleIssue>[1];
}

function syncedIssue(statusName: string, statusId = 2) {
  return {
    id: "issue-1",
    redmineIssueId: REMOTE_ISSUE_ID,
    subject: "Fix the DRC export",
    statusId,
    statusName,
    priority: "High",
    projectName: "Streamline",
    assignedToName: "MBU",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("syncSingleIssue → outbound webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueFindFirst.mockResolvedValue(null);
    mockIssueActivityEventFindFirst.mockResolvedValue(null);
    mockTimeEntryAggregate.mockResolvedValue({ _sum: { hours: 0 } });
    // As in this Redmine: only "Closed" (id 5) is a closed status.
    mockStatusCatalogFindMany.mockResolvedValue([{ id: 5 }]);
    mockWebhookEnv.webhookCompletedStatuses = ["Resolved"];
  });

  it("dispatches ticket.created with Slack notifications off", async () => {
    mockIssueFindUnique.mockResolvedValue(null);
    mockIssueUpsert.mockResolvedValue(syncedIssue("New"));

    await syncSingleIssue(USER_ID, fakeClient(), REMOTE_ISSUE_ID, { sendNotifications: false, sendWebhooks: true });

    expect(mockDispatchWebhook).toHaveBeenCalledWith(
      "ticket.created",
      expect.objectContaining({ redmineIssueId: REMOTE_ISSUE_ID }),
      undefined,
      USER_ID,
    );
    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(mockNotifyIssueChanges).not.toHaveBeenCalled();
  });

  it("still detects what changed for ticket.status_changed with Slack notifications off", async () => {
    mockIssueFindUnique.mockResolvedValue({
      id: "issue-1",
      statusId: 1,
      statusName: "New",
      priority: "High",
      assignedToName: "MBU",
      subject: "Fix the DRC export",
      dueDate: null,
      doneRatio: 0,
    });
    mockIssueUpsert.mockResolvedValue(syncedIssue("In Progress"));

    await syncSingleIssue(USER_ID, fakeClient("In Progress"), REMOTE_ISSUE_ID, { sendNotifications: false, sendWebhooks: true });

    expect(mockDispatchWebhook).toHaveBeenCalledWith(
      "ticket.status_changed",
      expect.anything(),
      [{ field: "status", oldValue: "New", newValue: "In Progress" }],
      USER_ID,
    );
  });

  function cachedAs(statusId: number, statusName: string) {
    mockIssueFindUnique.mockResolvedValue({
      id: "issue-1",
      statusId,
      statusName,
      priority: "High",
      assignedToName: "MBU",
      subject: "Fix the DRC export",
      dueDate: null,
      doneRatio: 0,
    });
  }

  it("dispatches ticket.completed when the ticket moves into a status Redmine marks closed", async () => {
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Closed", 5));

    await syncSingleIssue(USER_ID, fakeClient("Closed", 5), REMOTE_ISSUE_ID, { sendWebhooks: true });

    expect(mockStatusCatalogFindMany).toHaveBeenCalledWith({
      where: { scope: JSON.stringify([USER_ID, "https://redmine.example.com"]), isClosed: true },
      select: { id: true },
    });
    expect(mockDispatchWebhook).toHaveBeenCalledWith(
      "ticket.completed",
      expect.anything(),
      [{ field: "status", oldValue: "New", newValue: "Closed" }],
      USER_ID,
    );
  });

  it("counts Resolved as completed by default, though Redmine keeps it open", async () => {
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Resolved", 3));

    await syncSingleIssue(USER_ID, fakeClient("Resolved", 3), REMOTE_ISSUE_ID, { sendWebhooks: true });

    expect(mockDispatchWebhook).toHaveBeenCalledWith("ticket.completed", expect.anything(), expect.anything(), USER_ID);
  });

  it("does not complete a ticket twice when it goes from Resolved to Closed", async () => {
    cachedAs(3, "Resolved");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Closed", 5));

    await syncSingleIssue(USER_ID, fakeClient("Closed", 5), REMOTE_ISSUE_ID, { sendWebhooks: true });

    expect(mockDispatchWebhook).toHaveBeenCalledWith("ticket.status_changed", expect.anything(), expect.anything(), USER_ID);
  });

  it("follows WEBHOOK_COMPLETED_STATUSES, matching names case-insensitively", async () => {
    mockWebhookEnv.webhookCompletedStatuses = ["pass"];
    cachedAs(10, "Testing");
    mockIssueUpsert.mockResolvedValue(syncedIssue("PASS", 21));

    await syncSingleIssue(USER_ID, fakeClient("PASS", 21), REMOTE_ISSUE_ID, { sendWebhooks: true });
    expect(mockDispatchWebhook).toHaveBeenLastCalledWith("ticket.completed", expect.anything(), expect.anything(), USER_ID);

    mockWebhookEnv.webhookCompletedStatuses = [];
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Resolved", 3));
    await syncSingleIssue(USER_ID, fakeClient("Resolved", 3), REMOTE_ISSUE_ID, { sendWebhooks: true });
    expect(mockDispatchWebhook).toHaveBeenLastCalledWith("ticket.status_changed", expect.anything(), expect.anything(), USER_ID);
  });

  it("treats reopening a closed ticket as a status change", async () => {
    cachedAs(5, "Closed");
    mockIssueUpsert.mockResolvedValue(syncedIssue("In Progress", 2));

    await syncSingleIssue(USER_ID, fakeClient("In Progress", 2), REMOTE_ISSUE_ID, { sendWebhooks: true });

    expect(mockDispatchWebhook).toHaveBeenCalledWith("ticket.status_changed", expect.anything(), expect.anything(), USER_ID);
  });

  it("sends no webhooks when the caller doesn't ask for them, even with notifications on", async () => {
    mockIssueFindUnique.mockResolvedValue(null);
    mockIssueUpsert.mockResolvedValue(syncedIssue("New"));
    mockNotifyIssueChanges.mockResolvedValue(null);

    await syncSingleIssue(USER_ID, fakeClient(), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockDispatchWebhook).not.toHaveBeenCalled();
    expect(mockNotifyIssueChanges).toHaveBeenCalled();
  });
});

describe("syncSingleIssue → PWA push notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueFindFirst.mockResolvedValue(null);
    mockIssueActivityEventFindFirst.mockResolvedValue(null);
    mockTimeEntryAggregate.mockResolvedValue({ _sum: { hours: 0 } });
  });

  it("pushes a new issue with Slack notifications off", async () => {
    mockIssueFindUnique.mockResolvedValue(null);
    mockIssueUpsert.mockResolvedValue(syncedIssue("New"));

    await syncSingleIssue(USER_ID, fakeClient(), REMOTE_ISSUE_ID, { sendNotifications: false, sendPush: true });

    expect(mockSendPushNotification).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: "New Issue Assigned" }),
    );
    expect(mockNotifyIssueChanges).not.toHaveBeenCalled();
  });

  it("still detects a status change to push with Slack notifications off", async () => {
    mockIssueFindUnique.mockResolvedValue({
      id: "issue-1",
      statusName: "New",
      priority: "High",
      assignedToName: "MBU",
      subject: "Fix the DRC export",
      dueDate: null,
      doneRatio: 0,
    });
    mockIssueUpsert.mockResolvedValue(syncedIssue("In Progress"));

    await syncSingleIssue(USER_ID, fakeClient("In Progress"), REMOTE_ISSUE_ID, { sendNotifications: false, sendPush: true });

    expect(mockSendPushNotification).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ body: "Status changed from New to In Progress" }),
    );
  });

  it("sends no push when the caller doesn't ask for it, even with Slack notifications on", async () => {
    mockIssueFindUnique.mockResolvedValue(null);
    mockIssueUpsert.mockResolvedValue(syncedIssue("New"));
    mockNotifyIssueChanges.mockResolvedValue(null);

    await syncSingleIssue(USER_ID, fakeClient(), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(mockNotifyIssueChanges).toHaveBeenCalled();
  });
});

describe("syncSingleIssue → Slack close detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueFindFirst.mockResolvedValue(null);
    mockIssueActivityEventFindFirst.mockResolvedValue(null);
    mockTimeEntryAggregate.mockResolvedValue({ _sum: { hours: 0 } });
    // As in this Redmine: only "Closed" (id 5) is a closed status.
    mockStatusCatalogFindMany.mockResolvedValue([{ id: 5 }]);
    mockWebhookEnv.webhookCompletedStatuses = ["Resolved"];
    mockNotifyIssueChanges.mockResolvedValue({ success: true });
  });

  function cachedAs(statusId: number, statusName: string) {
    mockIssueFindUnique.mockResolvedValue({
      id: "issue-1",
      statusId,
      statusName,
      priority: "High",
      assignedToName: "MBU",
      subject: "Fix the DRC export",
      dueDate: null,
      doneRatio: 0,
    });
  }

  it("marks a move into a status Redmine closes as a close, whatever its name", async () => {
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Rejected", 5));

    await syncSingleIssue(USER_ID, fakeClient("Rejected", 5), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockNotifyIssueChanges).toHaveBeenCalledWith(
      expect.objectContaining({ statusName: "New", isClosed: false }),
      expect.objectContaining({ statusName: "Rejected", isClosed: true }),
    );
  });

  it("does not mark an open status with a done-sounding name as closed", async () => {
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Not done", 4));

    await syncSingleIssue(USER_ID, fakeClient("Not done", 4), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockNotifyIssueChanges).toHaveBeenCalledWith(
      expect.objectContaining({ isClosed: false }),
      expect.objectContaining({ statusName: "Not done", isClosed: false }),
    );
  });

  it("counts Resolved as closed, as ticket.completed does", async () => {
    cachedAs(1, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("Resolved", 3));

    await syncSingleIssue(USER_ID, fakeClient("Resolved", 3), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockNotifyIssueChanges).toHaveBeenCalledWith(
      expect.objectContaining({ isClosed: false }),
      expect.objectContaining({ statusName: "Resolved", isClosed: true }),
    );
  });

  it("skips the status catalog lookup when the status didn't change", async () => {
    cachedAs(2, "New");
    mockIssueUpsert.mockResolvedValue(syncedIssue("New", 2));

    await syncSingleIssue(USER_ID, fakeClient("New", 2), REMOTE_ISSUE_ID, { sendNotifications: true });

    expect(mockStatusCatalogFindMany).not.toHaveBeenCalled();
    expect(mockNotifyIssueChanges).toHaveBeenCalled();
  });
});
