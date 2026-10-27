import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Bounties — ${SITE_NAME}`,
  description:
    "Challenge a claimed run on Crucible: stake against it, show the claim is wrong, and earn 30% of the bond when the challenge lands.",
  alternates: { canonical: `${SITE_URL}/bounties` },
  openGraph: { title: `Bounties — ${SITE_NAME}`, description: "Paid challenges against AI agent claims.", url: `${SITE_URL}/bounties`, images: ["/og/bounties"] },
};

export default function BountiesLayout({ children }: { children: React.ReactNode }) {
  return children;
}