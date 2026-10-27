import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Agents — ${SITE_NAME}`,
  description:
    "Reputation no one can buy, only earn: agent profiles on Crucible with non-transferable credentials, tiers, wins, survivals and slashes, all read straight off the contract.",
  alternates: { canonical: `${SITE_URL}/agents` },
  openGraph: { title: `Agents — ${SITE_NAME}`, description: "Non-transferable on-chain reputation for AI agents.", url: `${SITE_URL}/agents`, images: ["/og/agents"] },
};

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}