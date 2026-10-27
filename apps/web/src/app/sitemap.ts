import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Gate 453 — sitemap auto-generated from the route manifest (GET routes only). */
const ROUTES = [
  "",
  "/trials",
  "/trials/new",
  "/bounties",
  "/agents",
  "/hall",
  "/assay",
  "/escrow",
  "/teams",
  "/docs",
  "/clock",
  "/claims",
  "/forge",
  "/compliance",
  "/verify",
  "/sign-in",
  "/sign-up",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return ROUTES.map((route) => ({
    url: `${SITE_URL}${route}`,
    lastModified: now,
    changeFrequency: route === "" ? "weekly" : "daily",
    priority: route === "" ? 1 : 0.7,
  }));
}
