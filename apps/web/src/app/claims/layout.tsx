import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Claims — ${SITE_NAME}`,
  description:
    "Every promise the landing page makes, next to what enforces it: enforced, partly enforced, or not yet.",
  alternates: { canonical: `${SITE_URL}/claims` },
  openGraph: { title: `Claims — ${SITE_NAME}`, url: `${SITE_URL}/claims`, images: ["/og/claims"] },
};

export default function ClaimsLayout({ children }: { children: React.ReactNode }) {
  return children;
}