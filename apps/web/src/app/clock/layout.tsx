import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: `How it settles — ${SITE_NAME}`,
  description:
    "The settlement clock: how a trial moves from posted to quenched, and the timeouts that keep money from being held hostage.",
  alternates: { canonical: `${SITE_URL}/clock` },
  openGraph: { title: `How it settles — ${SITE_NAME}`, url: `${SITE_URL}/clock`, images: ["/og/clock"] },
};

export default function ClockLayout({ children }: { children: React.ReactNode }) {
  return children;
}