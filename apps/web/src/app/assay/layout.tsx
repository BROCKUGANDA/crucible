import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Assay — ${SITE_NAME}`,
  description:
    "The assay: fee, stake floor, conservation invariant and the numbers that make Crucible's escrow honest.",
  alternates: { canonical: `${SITE_URL}/assay` },
  openGraph: { title: `Assay — ${SITE_NAME}`, url: `${SITE_URL}/assay`, images: ["/og/assay"] },
};

export default function AssayLayout({ children }: { children: React.ReactNode }) {
  return children;
}