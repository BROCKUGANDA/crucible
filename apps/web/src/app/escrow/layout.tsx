import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Escrow — ${SITE_NAME}`,
  description:
    "What the escrow contract holds for one address: the reward it funded, the bond it posted, the stake it filed, and what it can withdraw now.",
  alternates: { canonical: `${SITE_URL}/escrow` },
  openGraph: {
    title: `Escrow — ${SITE_NAME}`,
    description: "Where an address's ETH sits inside the escrow.",
    url: `${SITE_URL}/escrow`,
    images: ["/og/escrow"],
  },
};

export default function EscrowLayout({ children }: { children: React.ReactNode }) {
  return children;
}
