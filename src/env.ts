// Bindings and vars come from `wrangler types` (worker-configuration.d.ts); secrets are added here.
export type Env = Cloudflare.Env & {
  FREEAGENT_CLIENT_ID: string;
  FREEAGENT_CLIENT_SECRET: string;
  FORWARD_ADDRESS: string; // the forwarding address is a shared secret
  ALLOWED_SENDERS: string; // comma-separated
  NOTIFY_TO: string;
  OWNER_EMAIL: string;
};

export const CONFIDENCE_AUTO = 0.7;
export const GBP_WINDOW_DAYS = { before: 5, after: 21 };
export const FOREIGN_WINDOW_DAYS = { before: 3, after: 7 };
export const FX_TOLERANCE = 0.04;
export const STUCK_AFTER_DAYS = 14;
export const LOOKBACK_DAYS = 5;
export const MANUAL_MATCH_DAYS = 30;
export const MAX_FILE_BYTES = 5_000_000;
export const MIN_IMAGE_BYTES = 50_000;
export const CLAIRIC_MAX_IMAGE_BYTES = 4_194_304;
export const MAX_IMAGES = 4;
export const IMAGE_MAX_SIDE = 1600;
export const MIN_TEXT_CHARS = 40;
export const SHORT_PLAIN_TEXT_CHARS = 200;
export const ATTACH_BATCH = 10;
export const READ_GIVE_UP_HOURS = 24;
