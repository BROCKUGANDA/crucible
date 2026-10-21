import { SITE_URL } from "@/lib/site";

/**
 * RFC 9116 security contact. Kept as a route rather than a static file so the
 * canonical URL follows NEXT_PUBLIC_SITE_URL on every deployment.
 */
export function GET() {
  const body = [
    `Contact: mailto:otemaach@gmail.com`,
    `Expires: 2027-12-31T23:59:59.000Z`,
    `Preferred-Languages: en`,
    `Canonical: ${SITE_URL}/.well-known/security.txt`,
    ``,
  ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}
