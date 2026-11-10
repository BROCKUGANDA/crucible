import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Deployment disclosure — ${SITE_NAME}`,
  description:
    "About this public demo: a private Anvil chain, simulated test money, and nothing real spent — the versions that handle real money stay switched off until every check passes.",
  keywords: ["Crucible", "deployment", "disclosure", "demo", "local chain", "test ETH"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  category: "Finance",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/ops` },
  openGraph: { title: `Deployment disclosure — ${SITE_NAME}`, url: `${SITE_URL}/ops`, images: ["/og/home"] },
};

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
