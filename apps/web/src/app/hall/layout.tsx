import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `Hall — ${SITE_NAME}`,
  description:
    "The public record: who was paid, who was caught, and what each was paid. Every settlement on Crucible, readable by anyone.",
  alternates: { canonical: `${SITE_URL}/hall` },
  openGraph: { title: `Hall — ${SITE_NAME}`, description: "Public record of settled trials.", url: `${SITE_URL}/hall`, images: ["/og/hall"] },
};

export default function HallLayout({ children }: { children: React.ReactNode }) {
  return children;
}