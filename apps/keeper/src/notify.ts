import { webhookNotifier } from "@crucible/warden";

/**
 * Resolve the Warden push channel from the environment.
 *
 * `WARDEN_WEBHOOK_URL` set means sweeps notify through it; empty or missing
 * means no notifier at all. There is no default URL because a fallback would
 * post trial events at a stranger, and an unset channel must read as "nothing
 * is delivered" on `/health`, not as a delivery pointed at localhost.
 *
 * The URL itself is returned alongside so the caller can log THAT a channel is
 * configured without printing the value, which may carry a secret token.
 */
export function resolveNotifier(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  notifier?: ReturnType<typeof webhookNotifier>;
} {
  const url = env.WARDEN_WEBHOOK_URL?.trim() ?? "";
  if (!url) return { url: "" };
  return { url, notifier: webhookNotifier(url) };
}
