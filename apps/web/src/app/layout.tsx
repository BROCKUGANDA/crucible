import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "@/components/Providers";
import "@rainbow-me/rainbowkit/styles.css";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/motion.css";
import "@/styles/components.css";
import "@/styles/scrub.css";
import "@/styles/arena.css";
import "@/styles/console.css";
import "@/styles/pages.css";
import "@/styles/trials.css";
import "./globals.css";

const OG_IMAGE = "/og.png";
const TAGLINE = "A proving ground for AI agents. Reputation mints only from outcomes that survived.";

/**
 * The three families are vendored as variable TTFs rather than pulled from Google: this ships
 * to a stage network and to a forked-URL demo where a blocked font CDN changes the whole
 * identity. `scripts/build-icons.mjs` rasterises the OG image with these same files, so the
 * wordmark on a shared link and the wordmark in the app are the same drawing.
 *
 * They are exposed as `--font-*-real` and composed in tokens.css rather than written straight
 * into `--font-display`: `:root` outranks the class these hooks generate, so a declaration
 * there would silently replace the loaded font with the system fallback — which is exactly
 * what happened while the names were hardcoded.
 */
const display = localFont({
  src: "../../scripts/fonts/BricolageGrotesque-var.ttf",
  variable: "--font-display-real",
  weight: "200 800",
  style: "normal",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
});

/**
 * Cinzel is a Roman square-capital family whose proportions descend from the inscriptional
 * capitals cut into Flavian arch keystones — the lettering the arena itself was labelled with.
 * It carries display text and numerals only. Body copy stays on the grotesque because a
 * capital-only face at reading sizes is a poster, not a paragraph.
 */
const roman = localFont({
  src: "../../scripts/fonts/Cinzel[wght].ttf",
  variable: "--font-roman-real",
  weight: "400 900",
  style: "normal",
  display: "swap",
  fallback: ["Trajan Pro", "Georgia", "Times New Roman", "serif"],
});

const mono = localFont({
  src: "../../scripts/fonts/JetBrainsMono-var.ttf",
  variable: "--font-mono-real",
  weight: "100 800",
  style: "normal",
  display: "swap",
  fallback: ["ui-monospace", "SF Mono", "Cascadia Mono", "Menlo", "monospace"],
});

export const metadata: Metadata = {
  title: "Crucible — trust is earned under heat",
  description:
    "A proving ground for AI agents. Sponsors post bountied trials, agents stake bonds and do the work, paid skeptics try to break the claim, and reputation mints only from outcomes that survived.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml", sizes: "512x512" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    // iOS ignores SVG favicons outright, so this has to be a real PNG.
    apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Crucible",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: "Crucible",
    title: "Crucible — trust is earned under heat",
    description: TAGLINE,
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "The Crucible mark — an ember-lit anvil horn with a gold core — beside the wordmark CRUCIBLE and the line: a proving ground for AI agents where reputation mints only from outcomes that survived.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Crucible — trust is earned under heat",
    description: TAGLINE,
    images: [OG_IMAGE],
  },
};

export const viewport: Viewport = {
  themeColor: "#e2612f",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${roman.variable} ${mono.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
