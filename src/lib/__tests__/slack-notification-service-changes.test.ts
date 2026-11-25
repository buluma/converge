import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnv, mockNotifier } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
  mockNotifier: {
    notifyIssueCreated: vi.fn(),
    notifyIssueUpdated: vi.fn(),
    notifyIssueClosed: vi.fn(),
    notifyIssueAssigned: vi.fn(),
  },
}));

vi.mock("@/src/lib/env", () => ({ env: mockEnv }));
vi.mock("@/src/lib/db", () => ({ prisma: {} }));
vi.mock("@/src/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/src/lib/slack-notifier", () => ({
  SlackNotifier: Object.assign(
    vi.fn().mockImplementation(function () {
      return mockNotifier;
    }),
    {
      createDefaultConfig: (channelId: string, redmineBaseUrl: string, overrides: object) => ({
        channelId,
        redmineBaseUrl,
        ...overrides,
      }),
    },
  ),
}));

import { SlackNotificationService, type IssueState } from "@/src/lib/slack-notification-service";

function setEnv(overrides: Record<string, unknown>) {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  Object.assign(mockEnv, {
    slackBotToken: "xoxb-test",
    slackNotifyChannelId: "C0123456789",
    slackNotifyEnabled: true,
    slackNotifyOnCreate: true,
    slackNotifyOnUpdate: true,
    slackNotifyOnStatusChange: true,
    slackNotifyOnAssignment: true,
    slackNotifyOnInternalNote: true,
    redmineBaseUrl: "https://redmine.example.com",
    ...overrides,
  });
}

function state(overrides: Partial<IssueState> = {}): IssueState {
  return {
    id: "issue-1",
    redmineIssueId: 4321,
    subject: "Fix the DRC export",
    projectName: "Streamline",
    statusName: "In Progress",
    priorityName: "Normal",
    assignedToName: "MBU",
    updatedAt: "2026-11-23T09:00:00Z",
    doneRatio: 0,
    dueDate: null,
    ...overrides,
  };
}

describe("SlackNotificationService.notifyIssueChanges toggles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends no field-change message when SLACK_NOTIFY_ON_UPDATE is off", async () => {
    setEnv({ slackNotifyOnUpdate: false });

    await new SlackNotificationService().notifyIssueChanges(state(), state({ priorityName: "High", subject: "Renamed" }));

    expect(mockNotifier.notifyIssueUpdated).not.toHaveBeenCalled();
  });

  it("still sends status changes when SLACK_NOTIFY_ON_UPDATE is off, without the other fields", async () => {
    setEnv({ slackNotifyOnUpdate: false });

    await new SlackNotificationService().notifyIssueChanges(
      state(),
      state({ statusName: "Feedback", priorityName: "High" }),
    );

    expect(mockNotifier.notifyIssueUpdated).toHaveBeenCalledWith(expect.anything(), [
      { field: "status", oldValue: "In Progress", newValue: "Feedback" },
    ]);
  });

  it("sends field changes when SLACK_NOTIFY_ON_UPDATE is on and status changes are off", async () => {
    setEnv({ slackNotifyOnStatusChange: false });

    await new SlackNotificationService().notifyIssueChanges(
      state(),
      state({ statusName: "Feedback", priorityName: "High" }),
    );

    expect(mockNotifier.notifyIssueUpdated).toHaveBeenCalledWith(expect.anything(), [
      { field: "priority", oldValue: "Normal", newValue: "High" },
    ]);
  });
});

describe("SlackNotificationService.notifyIssueChanges closes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the isClosed flags over the status name", async () => {
    setEnv({});

    await new SlackNotificationService().notifyIssueChanges(
      state({ isClosed: false }),
      state({ statusName: "Not done", isClosed: false }),
    );

    expect(mockNotifier.notifyIssueClosed).not.toHaveBeenCalled();
    expect(mockNotifier.notifyIssueUpdated).toHaveBeenCalled();
  });

  it("sends a close message when the flags say the issue was just closed", async () => {
    setEnv({});

    await new SlackNotificationService().notifyIssueChanges(
      state({ isClosed: false }),
      state({ statusName: "Rejected", isClosed: true }),
    );

    expect(mockNotifier.notifyIssueClosed).toHaveBeenCalled();
  });

  it("falls back to the status name when no flags are given", async () => {
    setEnv({});

    await new SlackNotificationService().notifyIssueChanges(state(), state({ statusName: "Closed" }));

    expect(mockNotifier.notifyIssueClosed).toHaveBeenCalled();
  });

  it("sends no close message when status changes are off, but still sends the other changes", async () => {
    setEnv({ slackNotifyOnStatusChange: false });

    await new SlackNotificationService().notifyIssueChanges(
      state({ isClosed: false }),
      state({ statusName: "Closed", isClosed: true, priorityName: "High" }),
    );

    expect(mockNotifier.notifyIssueClosed).not.toHaveBeenCalled();
    expect(mockNotifier.notifyIssueUpdated).toHaveBeenCalledWith(expect.anything(), [
      { field: "priority", oldValue: "Normal", newValue: "High" },
    ]);
  });
});
