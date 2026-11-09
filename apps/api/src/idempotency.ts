/**
 * Idempotency keys for the routes that create something.
 *
 * A retried POST used to create a second trial draft or a second run, because nothing
 * remembered the first one. This store maps a caller-supplied key — scoped by the
 * authenticated principal, so one wallet cannot replay another's key — to the id the
 * first request produced. A replay returns that id, and the route answers with the
 * record it already has instead of creating a second one.
 *
 * In-memory by design and restart-lossy, like every other store here (ADR-0008): the
 * guarantee is per process, and a restart forgets it. Bounded both ways: entries expire
 * after TTL and the map evicts the oldest past MAX_ENTRIES, so a caller cannot grow it
 * without bound.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, { value: string; at: number }>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 1_000,
  ) {}

  get(scope: string, key: string): string | null {
    const k = this.k(scope, key);
    const entry = this.entries.get(k);
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(k);
      return null;
    }
    return entry.value;
  }

  set(scope: string, key: string, value: string): void {
    const k = this.k(scope, key);
    // Re-insert so the eviction order keeps the most recently used entry last.
    this.entries.delete(k);
    this.entries.set(k, { value, at: Date.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private k(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }
}

/** Read the `Idempotency-Key` header: absent is legal, unbounded is not. */
export function parseIdempotencyKey(
  raw: string | null | undefined,
): { key: string | null; error: string | null } {
  const key = raw?.trim();
  if (!key) return { key: null, error: null };
  if (key.length > 200) {
    return { key: null, error: "Idempotency-Key must be at most 200 characters" };
  }
  return { key, error: null };
}
