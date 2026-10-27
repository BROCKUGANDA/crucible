import { describe, expect, it } from "vitest";
import { resolveNotifier } from "../src/notify";

/**
 * When the keeper delivers push notifications, and when it honestly does not.
 *
 * The failure mode this file guards is a notifier pointed at a URL nobody
 * configured: a sweep that "notified" a default endpoint would read as
 * delivered while no operator ever saw it.
 */

describe("resolveNotifier", () => {
  it("attaches nothing when the URL is missing", () => {
    const { url, notifier } = resolveNotifier({});
    expect(url).toBe("");
    expect(notifier).toBeUndefined();
  });

  it("attaches nothing when the URL is blank", () => {
    const { url, notifier } = resolveNotifier({ WARDEN_WEBHOOK_URL: "   " });
    expect(url).toBe("");
    expect(notifier).toBeUndefined();
  });

  it("attaches a webhook notifier when the URL is set", () => {
    const { url, notifier } = resolveNotifier({ WARDEN_WEBHOOK_URL: "https://hooks.example/crucible" });
    expect(url).toBe("https://hooks.example/crucible");
    expect(notifier).toBeDefined();
  });

  it("trims the URL rather than posting at whitespace", () => {
    const { url, notifier } = resolveNotifier({ WARDEN_WEBHOOK_URL: "  https://hooks.example/crucible  " });
    expect(url).toBe("https://hooks.example/crucible");
    expect(notifier).toBeDefined();
  });
});
