import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnv, mockIssueFindUnique, mockNotifyInternalNoteAdded } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
  mockIssueFindUnique: vi.fn(),
  mockNotifyInternalNoteAdded: vi.fn(),
}));

vi.mock("@/src/lib/env", () => ({ env: mockEnv }));
vi.mock("@/src/lib/db", () => ({ prisma: { issue: { findUnique: mockIssueFindUnique } } }));
vi.mock("@/src/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/src/lib/slack-notifier", () => ({
  SlackNotifier: Object.assign(
    vi.fn().mockImplementation(function () {
      return { notifyInternalNoteAdded: mockNotifyInternalNoteAdded };
    }),
    { createDefaultConfig: (channelId: string) => ({ channelId }) },
  ),
}));

import { SlackNotificationService } from "@/src/lib/slack-notification-service";

function setEnv(overrides: Record<string, unknown>) {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  Object.assign(mockEnv, {
    slackBotToken: "xoxb-test",
    slackNotifyChannelId: "C0123456789",
    slackNotifyEnabled: true,
    redmineBaseUrl: "https://redmine.example.com",
    ...overrides,
  });
}

describe("SlackNotificationService.notifyInternalNoteAdded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is not a failure when Slack notifications are switched off", async () => {
    setEnv({ slackNotifyEnabled: false });

    const result = await new SlackNotificationService().notifyInternalNoteAdded("issue-1", "note", "MBU");

    expect(result).toEqual({ success: true });
    expect(mockIssueFindUnique).not.toHaveBeenCalled();
    expect(mockNotifyInternalNoteAdded).not.toHaveBeenCalled();
  });

  it("is not a failure when no Slack bot token is configured", async () => {
    setEnv({ slackBotToken: undefined });

    const result = await new SlackNotificationService().notifyInternalNoteAdded("issue-1", "note", "MBU");

    expect(result).toEqual({ success: true });
    expect(mockNotifyInternalNoteAdded).not.toHaveBeenCalled();
  });

  it("still reports a failure when Slack is on and the post fails", async () => {
    setEnv({});
    mockIssueFindUnique.mockResolvedValue({
      id: "issue-1",
      redmineIssueId: 4321,
      subject: "Fix the DRC export",
      projectName: "Streamline",
      statusName: "New",
      priority: "High",
      assignedToName: "MBU",
      updatedAt: new Date(),
      doneRatio: 0,
      dueDate: null,
    });
    mockNotifyInternalNoteAdded.mockRejectedValue(new Error("channel_not_found"));

    const result = await new SlackNotificationService().notifyInternalNoteAdded("issue-1", "note", "MBU");

    expect(result).toEqual({ success: false, error: "channel_not_found" });
  });
});
