/**
 * The canonical public origin. Metadata that builds absolute URLs (Open Graph,
 * canonical links, the sitemap, robots) all derive from here, so a hostname cutover
 * is a one-line change instead of a hunt through five files.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://crucible.svalley.tech";

export const SITE_NAME = "Crucible";
export const SITE_TAGLINE = "Trust is earned under heat";
