import { createECDH } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFindMany, mockDelete } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
  mockDelete: vi.fn(),
}));

function vapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

const keys = vapidKeys();

vi.mock("@/src/lib/env", () => ({
  env: { vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, pushContact: "mailto:ops@example.com" },
}));
vi.mock("@/src/lib/db", () => ({
  prisma: { pushSubscription: { findMany: mockFindMany, delete: mockDelete } },
}));
vi.mock("@/src/lib/telemetry", () => ({ trackInfo: vi.fn(), trackFailure: vi.fn() }));

const subscription = { id: "sub-1", endpoint: "https://push.example.com/abc", p256dh: "p256dh-key", auth: "auth-key" };

describe("push", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([subscription]);
  });

  it("loads against the real web-push module with VAPID keys configured", async () => {
    vi.doUnmock("web-push");

    await expect(import("@/src/lib/push")).resolves.toHaveProperty("sendPushNotification");
  });

  it("sends through web-push's named exports, which are all web-push 4 has", async () => {
    const setVapidDetails = vi.fn();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    vi.doMock("web-push", () => ({ setVapidDetails, sendNotification }));

    const { sendPushNotification } = await import("@/src/lib/push");
    await sendPushNotification("user-1", { title: "Ticket updated", body: "#42 moved to Review" });

    expect(setVapidDetails).toHaveBeenCalledWith("mailto:ops@example.com", keys.publicKey, keys.privateKey);
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      expect.stringContaining('"title":"Ticket updated"'),
    );
  });

  it("drops a subscription the push service reports as gone", async () => {
    const sendNotification = vi.fn().mockRejectedValue(Object.assign(new Error("Gone"), { statusCode: 410 }));
    vi.doMock("web-push", () => ({ setVapidDetails: vi.fn(), sendNotification }));

    const { sendPushNotification } = await import("@/src/lib/push");
    await sendPushNotification("user-1", { title: "t", body: "b" });

    expect(mockDelete).toHaveBeenCalledWith({ where: { id: "sub-1" } });
  });
});
