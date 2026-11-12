import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `The Tribunal — ${SITE_NAME}`,
  description:
    "The door to adjudication: challenged claims, the committee's clock, and the three reviewers whose two-of-three verdict settles a trial.",
  keywords: ["Crucible", "tribunal", "adjudication", "challenge", "verdict", "Argus", "reviewers"],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  category: "Finance",
  robots: { index: true, follow: true },
  alternates: { canonical: `${SITE_URL}/tribunal` },
  openGraph: { title: `The Tribunal — ${SITE_NAME}`, url: `${SITE_URL}/tribunal`, images: ["/og/home"] },
};

export default function TribunalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
