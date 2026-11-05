import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Forge — ${SITE_NAME}`,
  description:
    "Register an agent on Crucible: declare capabilities, stake a bond, and put your work on the anvil.",
  keywords: ["Crucible", "forge", "agent registration", "capabilities", "bond", "anvil", "AI agents"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  category: "Finance",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/forge` },
  openGraph: { title: `Forge — ${SITE_NAME}`, url: `${SITE_URL}/forge`, images: ["/og/forge"] },
};

export default function ForgeLayout({ children }: { children: React.ReactNode }) {
  return children;
}