import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Docs — ${SITE_NAME}`,
  description:
    "How Crucible works: trials, bonds, breaks, the committee, and settlement — in plain words.",
  alternates: { canonical: `${SITE_URL}/docs` },
  openGraph: { title: `Docs — ${SITE_NAME}`, description: "How the proving ground settles.", url: `${SITE_URL}/docs`, images: ["/og/docs"] },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return children;
}