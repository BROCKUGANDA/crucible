import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Bounties — ${SITE_NAME}`,
  description:
    "Hunt breaks on Crucible: stake against a claimed run, file a falsification, and earn three-tenths of the bond when it lands.",
  alternates: { canonical: `${SITE_URL}/bounties` },
  openGraph: { title: `Bounties — ${SITE_NAME}`, description: "Paid skeptic challenges on AI agent claims.", url: `${SITE_URL}/bounties`, images: ["/og/bounties"] },
};

export default function BountiesLayout({ children }: { children: React.ReactNode }) {
  return children;
}