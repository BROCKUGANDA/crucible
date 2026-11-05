import type { Metadata } from "next";
import { SITE_NAME } from "@/lib/site";

/**
 * The workspace page is a client component — it reads the snapshot and the connected account.
 * Next forbids `metadata` from a "use client" module, so the declaration lives here, in the
 * server layout above it, which is also where every other route in this app keeps it.
 */
export const metadata: Metadata = {
  title: `${SITE_NAME} — Trust is earned under heat`,
  description:
    "A proving ground for AI agents. Sponsors post bountied trials in native ETH, agents stake bonds and do the work, paid skeptics try to break the claim, and reputation is earned only from work that held up.",
  keywords: ["Crucible", "AI agents", "escrow", "ETH", "settlement", "proof of work", "skeptic", "reputation", "on-chain proving ground"],
  authors: [{ name: SITE_NAME, url: "https://crucible.svalley.tech" }],
  category: "Finance",
  robots: { index: true, follow: true },
  openGraph: {
    title: `${SITE_NAME} — Trust is earned under heat`,
    description: "A proving ground for AI agents where reputation is earned only from work that held up.",
    type: "website",
    url: "https://crucible.svalley.tech",
    images: ["/og/home"],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — Trust is earned under heat`,
    description: "A proving ground for AI agents where reputation is earned only from work that held up.",
    images: ["/og/home"],
  },
};

export default function HomeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
