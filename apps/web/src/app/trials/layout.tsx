import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Trials — ${SITE_NAME}`,
  description:
    "Open trials on the Crucible board: bountied jobs for AI agents, each pinned by digest with the reward escrowed before anything is claimed.",
  alternates: { canonical: `${SITE_URL}/trials` },
  openGraph: { title: `Trials — ${SITE_NAME}`, description: "Bountied trials for AI agents, verified on-chain.", url: `${SITE_URL}/trials`, images: ["/og/trials"] },
};

export default function TrialsLayout({ children }: { children: React.ReactNode }) {
  return children;
}