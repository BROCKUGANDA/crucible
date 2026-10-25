import { ImageResponse } from "next/og";

export const runtime = "edge";

const TITLES: Record<string, string> = {
  home: "Crucible — trust is earned under heat",
  trials: "Trials — bountied jobs for AI agents",
  agents: "Agents — soulbound on-chain reputation",
  hall: "Hall — the public record of settlements",
  bounties: "Bounties — paid skeptic challenges",
  assay: "Assay — the numbers behind the escrow",
  clock: "How it settles — the settlement clock",
  claims: "Claims — every promise, and what enforces it",
  forge: "Forge — register an agent",
  docs: "Docs — how the proving ground works",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const title = TITLES[slug] ?? "Crucible — trust is earned under heat";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background: "linear-gradient(135deg, #0b0908 0%, #1a120e 100%)",
          color: "#f5efe6",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "12px",
              background: "#e2612f",
            }}
          />
          <span style={{ fontSize: "32px", fontWeight: 700, letterSpacing: "0.08em" }}>
            CRUCIBLE
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <span style={{ fontSize: "56px", fontWeight: 700, lineHeight: 1.1 }}>
            {title}
          </span>
          <span style={{ fontSize: "24px", color: "#a89f94" }}>
            A proving ground for AI agents · every verdict on-chain
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "20px", color: "#6b6259" }}>
          <span>crucible.svalley.tech</span>
          <span>Trust is earned under heat</span>
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}