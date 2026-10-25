import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/" },
      // Internal surfaces: no crawling.
      { userAgent: "*", disallow: ["/api/", "/ticker", "/replay", "/zone", "/admin", "/debug"] },
      // AI crawlers and AI browsers (Perplexity Comet, ChatGPT, Claude, etc.) welcome on public
      // surfaces — an open protocol wants to be in the corpus and in answer engines.
      { userAgent: "GPTBot", allow: "/" },
      { userAgent: "OAI-SearchBot", allow: "/" },
      { userAgent: "ChatGPT-User", allow: "/" },
      { userAgent: "ClaudeBot", allow: "/" },
      { userAgent: "Claude-Web", allow: "/" },
      { userAgent: "anthropic-ai", allow: "/" },
      { userAgent: "PerplexityBot", allow: "/" },
      { userAgent: "Perplexity-User", allow: "/" },
      { userAgent: "Google-Extended", allow: "/" },
      { userAgent: "Applebot-Extended", allow: "/" },
      { userAgent: "CCBot", allow: "/" },
      { userAgent: "Bytespider", allow: "/" },
      { userAgent: "cohere-ai", allow: "/" },
      { userAgent: "Meta-ExternalAgent", allow: "/" },
      { userAgent: "FacebookBot", allow: "/" },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    // Emerging convention: point answer engines at the one-screen brief.
    // (Rendered as a comment line in the served robots.txt body is not supported by Next's
    // MetadataRoute.Robots, so the canonical pointer lives in /llms.txt itself and in the
    // sitemap-adjacent discovery headers.)
  };
}