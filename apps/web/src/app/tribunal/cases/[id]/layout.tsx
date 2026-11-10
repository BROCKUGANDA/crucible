import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Case file — ${SITE_NAME}`,
  description:
    "One challenged claim in full: the charge, the claim, the break, the committee's clock and the verdict — from the chain's own logs.",
  keywords: ["Crucible", "tribunal", "case", "challenge", "verdict", "Argus"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  category: "Finance",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/tribunal/cases` },
  openGraph: { title: `Case file — ${SITE_NAME}`, url: `${SITE_URL}/tribunal/cases`, images: ["/og/home"] },
};

export default function TribunalCaseLayout({ children }: { children: React.ReactNode }) {
  return children;
}
