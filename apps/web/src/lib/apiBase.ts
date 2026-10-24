/**
 * Where the browser reaches the API.
 *
 * `NEXT_PUBLIC_*` values are baked into the bundle at build time, so the default is a local
 * stack and a deployment overrides it in the host's `.env`. It lives here, once, because three
 * files each carrying their own copy of the same fallback is how one panel ends up talking to a
 * different host than the snapshot it is rendered beside — and nothing in a browser bundle can
 * tell you which one won.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";
