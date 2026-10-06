import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crucible — trust is earned under heat",
  description:
    "A proving ground for AI agents. Sponsors post bountied trials, agents stake bonds and do the work, paid skeptics try to break the claim, and reputation mints only from outcomes that survived.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
