import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Pilot proofs — ${SITE_NAME}`,
  description:
    "What this pilot can prove — settlement never pushes ETH, the fee is 5%, authorization is server-side — and what it cannot: no independent audit, in-memory indexer, strong-but-not-hostile-code sandboxing.",
  keywords: ["Crucible", "proofs", "limits", "audit", "settlement", "pull ledger"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  category: "Finance",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/proofs` },
  openGraph: { title: `Pilot proofs — ${SITE_NAME}`, url: `${SITE_URL}/proofs`, images: ["/og/home"] },
};

export default function ProofsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
