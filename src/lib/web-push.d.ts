declare module "web-push" {
  interface PushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }

  interface WebPushOptions {
    TTL?: number;
    vapidDetails?: VapidDetails;
    proxy?: string;
  }

  // web-push 4 is ESM with named exports only; there is no default export.
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function sendNotification(subscription: PushSubscription, payload?: string, options?: WebPushOptions): Promise<void>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
}
