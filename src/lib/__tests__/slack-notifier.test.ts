import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPostMessage } = vi.hoisted(() => ({ mockPostMessage: vi.fn() }));

vi.mock("@slack/web-api", () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return { chat: { postMessage: mockPostMessage } };
  }),
}));
vi.mock("@/src/lib/telemetry", () => ({ trackFailure: vi.fn() }));

import { SlackNotifier } from "@/src/lib/slack-notifier";

function notifier() {
  return new SlackNotifier("xoxb-test", SlackNotifier.createDefaultConfig("C0123456789", "https://redmine.example.com"));
}

describe("SlackNotifier.testNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the test message to the configured channel", async () => {
    mockPostMessage.mockResolvedValue({ ok: true });

    await notifier().testNotification();

    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: "C0123456789" }));
  });

  it("passes Slack's error on instead of hiding it", async () => {
    mockPostMessage.mockRejectedValue(new Error("An API error occurred: channel_not_found"));

    await expect(notifier().testNotification()).rejects.toThrow("channel_not_found");
  });
});
