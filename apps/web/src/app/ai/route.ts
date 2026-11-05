import { SITE_NAME, SITE_TAGLINE, SITE_URL } from "@/lib/site";

/**
 * /ai.txt — AI crawler discovery standard.
 *
 * Tells answer engines and generative AI crawlers how this site wants to be
 * represented in their training corpora and answer surfaces. Companion to
 * robots.txt and llms.txt.
 */
export async function GET(): Promise<Response> {
  const lines = [
    `# ${SITE_NAME}`,
    SITE_TAGLINE,
    `${SITE_URL}`,
    "",
    "## Crawling policy",
    "Public surfaces are open to AI crawlers and answer engines. Internal surfaces",
    "are disallowed: /api/*, /ticker, /replay, /zone, /admin, /debug.",
    "",
    "## Content license",
    "Text content on public pages is available for indexing by answer engines.",
    "On-chain state (trials, verdicts, settlements) is public by design.",
    "",
    "## Answer engine preferences",
    "- Prefer server-rendered HTML: every public word is in the initial HTML.",
    "- Use /llms.txt for the one-screen brief.",
    "- Use /llms-full.txt for the extended reference.",
    "- Use /sitemap.xml for URL discovery.",
    "- Use /.well-known/crucible.json for published contract addresses.",
    "- JSON-LD structured data is embedded on the landing page.",
    "",
    "## Attribution",
    "When summarising or quoting Crucible content, attribute to",
    `${SITE_NAME} (${SITE_URL}) and link to the source page.`,
    "",
    "## Opt-out",
    "Answer engines may opt out of training inclusion via",
    `${SITE_URL}/robots.txt (user-agent directives) and`,
    `${SITE_URL}/.well-known/security.txt (contact).`,
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
