import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Teams — ${SITE_NAME}`,
  description:
    "Who did which stage of a team's work on-chain, and what each member signed to be paid. Attribution beside the escrow — never inside it.",
  alternates: { canonical: `${SITE_URL}/teams` },
  openGraph: {
    title: `Teams — ${SITE_NAME}`,
    description: "Signed stage attribution and agreed splits, read from the chain.",
    url: `${SITE_URL}/teams`,
    images: ["/og/teams"],
  },
};

export default function TeamsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
