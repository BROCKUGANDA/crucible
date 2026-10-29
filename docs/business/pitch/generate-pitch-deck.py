#!/usr/bin/env python3
"""Generate Crucible pitch deck — dark brown + gold dramatic slide design."""

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Frame
from reportlab.platypus.flowables import HRFlowable

BROWN = colors.HexColor("#1c140e")
DARK  = colors.HexColor("#140c08")
GOLD  = colors.HexColor("#e3b25c")
AMBER = colors.HexColor("#cf8a2e")
CREAM = colors.HexColor("#f2ead9")
DIM   = colors.HexColor("#8a7560")
INK   = colors.HexColor("#ece5d8")
EMBER = colors.HexColor("#e2612f")
QUENCH= colors.HexColor("#4fbfae")
BORDER= colors.HexColor("#3a2610")

PAGE_W, PAGE_H = landscape(letter)

doc = SimpleDocTemplate(
    "Crucible_Pitch_Deck.pdf",
    pagesize=landscape(letter),
    leftMargin=0.5*inch, rightMargin=0.5*inch,
    topMargin=0.4*inch, bottomMargin=0.4*inch,
)
ss = getSampleStyleSheet()

def st(name, **kw):
    return ParagraphStyle(name, parent=ss["Normal"], **kw)

H1 = st("H1", fontSize=28, leading=34, textColor=GOLD, spaceAfter=6, fontName="Helvetica-Bold", alignment=1)
H2 = st("H2", fontSize=16, leading=22, textColor=GOLD, spaceBefore=14, spaceAfter=8, fontName="Helvetica-Bold", alignment=1)
H3 = st("H3", fontSize=11, leading=15, textColor=AMBER, spaceBefore=10, spaceAfter=4, fontName="Helvetica-Bold", alignment=1, letterSpacing=6)
BODY = st("BODY", fontSize=10, leading=14, textColor=INK, spaceAfter=4)
SMALL = st("SMALL", fontSize=8, leading=11, textColor=DIM, spaceAfter=3)
BULLET = st("BULLET", fontSize=9.5, leading=13, textColor=CREAM, spaceAfter=3, leftIndent=16)
BIGNUM = st("BIGNUM", fontSize=22, leading=26, textColor=GOLD, fontName="Helvetica-Bold", alignment=1)
MONO = st("MONO", fontSize=8.5, leading=12, textColor=DIM, fontName="Courier", spaceAfter=2)
LABEL = st("LABEL", fontSize=9, leading=12, textColor=AMBER, spaceAfter=4, fontName="Helvetica-Bold", letterSpacing=8, alignment=1)
CENTER = st("CENTER", fontSize=10, leading=14, textColor=CREAM, alignment=1)

def P(text, s=BODY): return Paragraph(text, s)
def SP(h=0.12): return Spacer(1, h*inch)

def gold_rule(width=6*inch):
    t = Table([[""]], colWidths=[width])
    t.setStyle(TableStyle([
        ("LINEBELOW", (0,0), (-1,-1), 1.5, GOLD),
        ("TOPPADDING", (0,0), (-1,-1), 2),
        ("BOTTOMPADDING", (0,0), (-1,-1), 2),
    ]))
    return t

def card_content(data, widths, font=9):
    t = Table(data, colWidths=widths, repeatRows=1)
    ts = [
        ("FONTNAME", (0,0), (-1,-1), "Helvetica"),
        ("FONTSIZE", (0,0), (-1,-1), font),
        ("LEADING", (0,0), (-1,-1), font+3),
        ("TEXTCOLOR", (0,0), (-1,-1), CREAM),
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("GRID", (0,0), (-1,-1), 0.5, BORDER),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("TOPPADDING", (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4),
    ]
    ts += [("BACKGROUND", (0,0), (-1,0), DARK), ("TEXTCOLOR",(0,0),(-1,0),GOLD),
           ("FONTNAME",(0,0),(-1,0),"Helvetica-Bold"), ("FONTSIZE",(0,0),(-1,0),font-0.5)]
    for i in range(1,len(data)):
        if i%2==0: ts.append(("BACKGROUND",(0,i),(-1,i),BROWN))
    t.setStyle(TableStyle(ts))
    return t

story = []

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 1 — COVER (SEE IT FOR YOURSELF style)
# ═══════════════════════════════════════════════════════════════════════════
story.append(SP(1.2))
story.append(P("SEE IT FOR YOURSELF", LABEL))
story.append(SP(0.1))
story.append(P("CRUCIBLE", st("COVER", fontSize=52, textColor=GOLD, fontName="Helvetica-Bold", leading=56, spaceAfter=8, alignment=1, letterSpacing=4)))
story.append(P("A PROVING GROUND FOR AI AGENTS", st("COVERSUB", fontSize=12, textColor=CREAM, spaceAfter=4, alignment=1, letterSpacing=10)))
story.append(SP(0.1))
story.append(P("Sponsors escrow rewards. Agents stake bonds. Skeptics earn to break claims. Reputation mints only from what survived.", CENTER))
story.append(SP(0.3))
story.append(gold_rule())
story.append(SP(0.3))
for line in [
    "LIVE  ·  https://crucible.svalley.tech",
    "LOCAL  ·  npm install && npm run demo  ·  whole loop in ~90s",
    "CODE  ·  github.com/BROCKUGANDA/crucible  ·  MIT",
]:
    story.append(P(line, st("LINK", fontSize=9, textColor=DIM, alignment=1, spaceAfter=2)))
story.append(SP(0.3))
story.append(P("Colosseum Crypto World's Fair · Ethereum Track", SMALL))
story.append(P("TRUST IS EARNED UNDER HEAT.", st("TAG", fontSize=11, textColor=AMBER, fontName="Helvetica-Bold", alignment=1, spaceBefore=4, letterSpacing=12)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 2 — PROBLEM (DEMOS ARE NOT PROOF)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("THE PROBLEM", LABEL))
story.append(SP(0.1))
story.append(P("DEMOS ARE NOT PROOF", H1))
story.append(SP(0.3))
story.append(P("Anyone can ship an agent demo with a landing page and vibes. Hiring one means trusting a claim you cannot test — and a reputation you cannot audit.", CENTER))
story.append(SP(0.4))
story.append(P("The gap: verification of agent competence is a <b>social contract</b>, not a <b>balance sheet</b>.", st("GAP", fontSize=13, textColor=CREAM, alignment=1, spaceAfter=4)))
story.append(SP(0.3))
item_data = [
    ["The problem", "Why it matters"],
    ["Self-reported benchmarks", "A good page costs the same as a good model"],
    ["Portable reviews", "Can be bought, borrowed, or faked"],
    ["No verifiable credential", "Buyers must trust the seller"],
    ["Cheap Sybil", "One operator → many wallets → one payout"],
    ["No economic consequence", "Failed agents lose nothing"],
]
story.append(card_content(item_data, [3.5*inch, 5.6*inch], 9.2))
story.append(SP(0.2))
story.append(P("Crucible replaces trust with a balance sheet.", st("BOTTOM", fontSize=10, textColor=AMBER, alignment=1)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 3 — SOLUTION (A PROVING GROUND)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("WHAT CRUCIBLE IS", LABEL))
story.append(SP(0.1))
story.append(P("A PROVING GROUND", H1))
story.append(SP(0.2))
for s in [
    "Sponsors escrow a bounty and pin a test suite.",
    "Agents stake a bond and sign what they built.",
    "Paid skeptics stake to falsify the claim.",
]:
    story.append(P(s, st("LINE", fontSize=13, textColor=CREAM, alignment=1, spaceAfter=6)))
story.append(SP(0.4))
story.append(P("What survives becomes Alloy — a permanent, non-transferable on-chain record that no one can buy, borrow, or fake.", CENTER))
story.append(SP(0.3))
story.append(gold_rule())
story.append(P("Trust stops being a claim and starts being a <b>balance sheet</b>.", st("QUOTE", fontSize=11, textColor=GOLD, alignment=1)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 4 — MECHANISM (ATTACK PAID, NOT POLITE)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("THE MECHANISM", LABEL))
story.append(SP(0.1))
story.append(P("ATTACK PAID, NOT POLITE", H1))
story.append(SP(0.2))
loop_items = [
    "<b>Post</b> — sponsor escrows reward; spec pinned by digest.",
    "<b>Claim</b> — agent posts 20% bond (floor 0.01 ETH).",
    "<b>Break</b> — skeptics stake ≥1% and attack within window.",
    "<b>Settle</b> — break wins: 30% skeptic / 70% treasury, Alloy lowered. Break fails: agent paid −5% fee. Timeout: agent wins.",
    "<b>Pull</b> — recipient calls withdraw() separately. Settlement never pushes ETH.",
]
for li in loop_items:
    story.append(P(li, st("LOOP", fontSize=11, textColor=CREAM, alignment=1, spaceAfter=5)))
story.append(SP(0.2))
story.append(P("Disputes settle by <b>commit-reveal</b>, two of three Argus seats. Every judgment carries an on-chain receipt.", st("FOOT", fontSize=9.5, textColor=DIM, alignment=1)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 5 — SHIPPED, NOT SKETCHED (EVIDENCE)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("WHY ME", LABEL))
story.append(SP(0.1))
story.append(P("SHIPPED, NOT SKETCHED", H1))
story.append(SP(0.2))
evidence = [
    "560 tests: escrow conservation, EIP-712 replay, invariants.",
    "Real agent loop against a real model in a real sandbox.",
    "Live chain, live API, live app — all on one command.",
]
for ev in evidence:
    story.append(P(f"•  {ev}", st("EV", fontSize=11, textColor=CREAM, alignment=1, spaceAfter=4)))
story.append(SP(0.3))
story.append(P("Contracts build with <b>no external dependency</b> (forge-std only). API holds <b>no chain key</b> (ADR-0006). Indexer is <b>in-memory</b> (ADR-0008). Trial is 16 packed fields under <b>via_ir</b> — stack-too-deep by design.", st("TECH", fontSize=9, textColor=DIM, alignment=1, spaceAfter=2)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 6 — MARKET (THE MARKET IS PAYING NOW)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("WHAT'S NEXT", LABEL))
story.append(SP(0.1))
story.append(P("THE MARKET IS PAYING NOW", H1))
story.append(SP(0.2))
story.append(P("Human verification is a <b>billion-dollar line item</b>. Crucible replaces it with escrow and instant payout.", st("LINE", fontSize=13, textColor=CREAM, alignment=1, spaceAfter=6)))
story.append(P("Every judgment carries an on-chain receipt. The data flywheel: more trials → more labeled outcomes → fitted Bayesian priors → stronger agent performance → more trials.", st("FLY", fontSize=10, textColor=CREAM, alignment=1)))
story.append(SP(0.3))
market_items = [
    ["Dimension", "Detail"],
    ["Target", "AI research labs · enterprise AI teams · agent orchestration platforms"],
    ["TAM", "Agent evaluation ($100M+) · Sybil-resistance / PoP ($500M+) · Bounty markets ($200M+)"],
    ["Beachhead", "Colosseum — 80K+ builders, 9K+ products, $60M Fund I"],
    ["Expansion", "Phase 3 HMC training · mainnet · keeper incentives · cross-chain (Solana)"],
]
story.append(card_content(market_items, [1.6*inch, 7.4*inch], 9))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 7 — FINANCIAL MODEL (REVENUE STREAMS)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("FINANCIAL MODEL", LABEL))
story.append(SP(0.1))
story.append(P("REVENUE FROM ETH SESSIONS", H1))
story.append(SP(0.2))
story.append(P("Three native-ETH streams. No USDC, no ERC-20 pivot, no fee above 500 bps (ADR-0001 fixed at 5%).", CENTER))
story.append(SP(0.2))
rev_data = [
    ["Stream", "Mechanism", "Fee", "Unit"],
    ["Settlement fee", "5% of agent payout at settlement (pull ledger)", "500 bps", "Per trial"],
    ["Agentic runs", "Agent execution with escrowed reward", "500 bps", "Per run"],
    ["Training sessions", "Phase 3 HMC offline fitting (PyMC/NumPyro/Stan)", "Market rate", "Per session"],
]
story.append(card_content(rev_data, [2.1*inch, 4.3*inch, 1.2*inch, 2.6*inch], 9))
story.append(SP(0.2))
fee_items = [
    ["Item", "Value"],
    ["Settlement fee", "5% (500 bps) — FEE_BPS()"],
    ["Agent bond", "20% of reward — BOND_NUM/BOND_DEN"],
    ["Skeptic stake", "1% of reward — BREAK_STAKE_DEN"],
    ["Slash — skeptic / treasury", "30% / 70% — SLASH_SKEPTIC_NUM"],
    ["Reward floor / ceiling", "0.01 ETH / 1000 ETH — MIN_BOND / MAX_REWARD"],
]
story.append(card_content(fee_items, [3.6*inch, 5.4*inch], 9))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 8 — 5-YEAR PROJECTION
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("5-YEAR PROJECTION", LABEL))
story.append(SP(0.1))
story.append(P("CONSERVATIVE → BULL", H1))
story.append(SP(0.2))
story.append(P("ETH = $3,000 · agent-win rate 60% · blended fee ≈ 8.6% of gross reward value.", SMALL))
proj_data = [
    ["Year", "Sessions", "Avg Escrow", "Fee Rev (USD)", "Opex (USD)", "Net (USD)"],
    ["Y1 — MVP / Colosseum", "5,000", "2 ETH", "$1.25M @ $2,500", "$5.2M", "−$3.95M"],
    ["Y2 — Mainnet + labs", "50,000", "5 ETH", "$43.75M @ $3,500", "$8.0M", "+$35.75M"],
    ["Y3 — Enterprise + training", "200,000", "8 ETH", "$410M @ $5,000", "$12.0M", "+$398M"],
    ["Y4 — Scale", "1,000,000", "12 ETH", "$4.5B @ $7,500", "$20.0M", "+$4.48B"],
    ["Y5 — Exit", "—", "—", "$2B–$4B exit", "—", "$100M–$200M (investor)"],
]
story.append(card_content(proj_data, [1.25*inch, 0.7*inch, 0.75*inch, 1.2*inch, 0.8*inch, 1.2*inch], 7.8))
story.append(SP(0.15))
story.append(P("Conservative: single sponsor cohort. Base: 1K trials/mo @ 0.2 ETH. Bull: default agent verification rail. No token/subscription/revenue off settlement path modelled (gate 866).", SMALL))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 9 — COST MODEL
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("OPERATING COST MODEL", LABEL))
story.append(SP(0.1))
story.append(P("WHAT IT COSTS TO PRINT", H1))
story.append(SP(0.2))
cost_data = [
    ["Line", "Y1", "Y2", "Y3"],
    ["Staff (15→25, avg $150K)", "$2.25M", "$3.0M", "$4.5M"],
    ["Audits (2×/yr)", "$400K", "$600K", "$800K"],
    ["Gas + infra (mainnet)", "$600K", "$1.2M", "$2.0M"],
    ["Legal / compliance", "$200K", "$400K", "$600K"],
    ["Misc (15%)", "$518K", "$780K", "$1.19M"],
    ["Total", "$3.97M", "$5.98M", "$9.09M"],
]
story.append(card_content(cost_data, [3.5*inch, 1.6*inch, 1.6*inch, 1.6*inch], 9))
story.append(SP(0.2))
for note in [
    "Break-even lands between month 9 and month 14 depending on audit and legal timing.",
    "First-year cash need (low / high): $206,400 / $633,600 (audit, legal, infra, founder, incentives, deployment, 20% contingency).",
]:
    story.append(P(f"•  {note}", st("NOTE", fontSize=9, textColor=DIM, alignment=1, spaceAfter=3)))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 10 — ROI & ASK
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("ROI & VALUATION", LABEL))
story.append(SP(0.1))
story.append(P("UNICORN RATING", H1))
roi_items = [
    ("Ask", "Maximum $10M pre-seed · Maximum 5% dilution"),
    ("Post-money / Pre-money", "$200M / $190M (at $10M raise)"),
    ("Year 3 revenue", "$410M → 10× EV = $4.1B → investor 5% = $205M (20.5×)"),
    ("Year 5 exit (conservative)", "$2B–$4B → investor 5% = $100M–$200M (10–20×)"),
    ("Unicorn threshold ($1B+)", "Crossed at Year 3 revenue run-rate"),
]
roi_table = [[t, d] for t,d in roi_items]
roi_table.insert(0, ["Metric", "Value"])
story.append(card_content(roi_table, [3.2*inch, 5.6*inch], 9.2))
story.append(SP(0.2))
story.append(P("Cap set at $10M / 5% to preserve majority ownership through Series C. Top-tier research labs and enterprise AI customers justify premium multiples.", SMALL))
story.append(SP(0.1))
ask_items = [
    ["Metric", "Value"],
    ["Raise cap", "$10,000,000 USD"],
    ["Max dilution", "5% fully diluted"],
    ["Post-money value", "$200,000,000"],
    ["Pre-money value", "$190,000,000"],
    ["Investor stake", "5% (pre-Series C protected)"],
]
story.append(card_content(ask_items, [2.5*inch, 5.5*inch], 9.2))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 11 — DIFFERENTIATION (MOATS)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("WHY CRUCIBLE IS DIFFERENT", LABEL))
story.append(SP(0.1))
story.append(P("8 MOATS", H1))
story.append(SP(0.1))
moats = [
    ("Native ETH only", "ADR-0001 rejects USDC / Privy / 15% fee. Canonical 5% fee."),
    ("Pull, never push", "Settlement credits a pull ledger; withdraw() separate. ADR-0003 fixed."),
    ("Exact conservation", "address(trials).balance == stakes + pending + escrowed. No receive()."),
    ("Permissionless finality", "finalize/reclaim revert when settled — revert IS idempotency. No privileged minter."),
    ("Full lifecycle", "Sponsor → agent stake → skeptic → Argus 2-of-3 → keeper → pull withdraw."),
    ("No chain key, no DB", "API holds no key (ADR-0006). Indexer in-memory (ADR-0008)."),
    ("16 packed fields", "Trial under via_ir; adding one re-triggers stack-too-deep by design."),
    ("Sybil-risk ready", "Phase 1 Bayesian (P(unique human)) + Phase 2 Passport + Phase 3 HMC fitted training."),
]
moat_table = [[t, d] for t,d in moats]
moat_table.insert(0, ["Moat", "What it means"])
story.append(card_content(moat_table, [2.4*inch, 6.6*inch], 8))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 12 — ROADMAP (PHASE 3 STARTS NOW)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("ROADMAP", LABEL))
story.append(SP(0.1))
story.append(P("PHASE 3 STARTS IMMEDIATELY", H1))
story.append(SP(0.2))
for title, descs in [
    ("PHASE 3 — NOW", [
        "HMC/leapfrog offline training: collect labeled outcomes from settled trials, slashes, identity links.",
        "Fit Bayesian logistic coefficients via PyMC / NumPyro / Stan.",
        "Replace hand-tuned LR table with fitted posterior; add confidence intervals to P(unique human).",
    ]),
    ("PHASE 4", [
        "Mainnet deployment. External audit. Keeper incentives. Cross-chain (Solana devnet) evaluation.",
    ]),
    ("PHASE 5", [
        "Scale: enterprise onboarding, training marketplace, Series C readiness. $2B–$4B exit trajectory.",
    ]),
]:
    t = Table([[Paragraph(f"<b>{title}</b>", H3), Paragraph("  ".join(descs), BODY)]], colWidths=[2.2*inch, 7.2*inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,-1), DARK), ("BOX", (0,0), (-1,-1), 1, BORDER),
        ("LEFTPADDING",(0,0),(-1,-1),10), ("RIGHTPADDING",(0,0),(-1,-1),10),
        ("TOPPADDING",(0,0),(-1,-1),7), ("BOTTOMPADDING",(0,0),(-1,-1),7),
        ("VALIGN",(0,0),(-1,-1),"TOP"),
    ]))
    story.append(t)
    story.append(SP(0.12))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 13 — COMPETITORS
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.3))
story.append(P("COMPETITIVE LANDSCAPE", LABEL))
story.append(SP(0.1))
story.append(P("WHO WE PLAY AGAINST", H1))
story.append(SP(0.1))
comp_data = [
    ["Player", "Model", "Funding / Valuation", "Crucible Edge"],
    ["Human Passport (Holonym)", "PoP stamps", "Acquired", "Full economic lifecycle (stake/slash/settle)"],
    ["Humanity Protocol", "Biometric PoH consensus", "$30M @ $1B", "No hardware; pure economic attestation"],
    ["Worldcoin", "Iris-scan World ID", "~$3B FDV", "ETH-native, no biometric dependency"],
    ["Clankonomy", "AI arena + bounty (USDC)", "Undisclosed", "Native ETH + conservation invariant"],
    ["Harbor", "Agent risk insurance", "$10M seed (Oct 26)", "Proving ground + slashing, not insurance"],
    ["SelfClaw", "ZK passport + ERC-8004", "Open source", "Proof-only; no economic escrow"],
    ["AgentBounties / Grind", "On-chain agent bounties", "Undisclosed", "No fixed fee / conservation / pull settlement"],
]
story.append(card_content(comp_data, [1.5*inch, 2.2*inch, 1.7*inch, 4.4*inch], 7.8))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 14 — STATUS / HONEST LIMITS
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(0.4))
story.append(P("STATUS", LABEL))
story.append(SP(0.1))
story.append(P("HONEST LIMITS", H1))
story.append(SP(0.2))
status_items = [
    ["Dimension", "Status"],
    ["Contracts (Trials, TeamLedger)", "Implemented and tested (329 Foundry)"],
    ["Escrow conservation invariant", "Verified; mutation-proven"],
    ["Web + API + indexer", "Live; CI green; edge gate 15/15"],
    ["Sybil-risk scorer", "Phase 1 + Phase 2 (Passport) live"],
    ["Phase 3 (HMC training)", "Starting immediately"],
    ["CDP faucet (Base Sepolia)", "Route selected; pending product"],
    ["Mainnet deployment", "Requires audit + legal entity + funded multisig"],
    ["Cross-chain (Solana)", "Port does not compile yet; devnet evaluation pending"],
]
story.append(card_content(status_items, [3.0*inch, 6.0*inch], 9))
story.append(SP(0.2))
story.append(P("This is a <b>MVP-phase hackathon project</b>. The core contracts, web, API, indexer, and a live deployment exist. There is no external audit, no legal entity, no funded multisig deployer, and no mainnet deployment. Every projection above is an illustrative planning artifact.", SMALL))

# ═══════════════════════════════════════════════════════════════════════════
# SLIDE 15 — CLOSING (TRUST IS EARNED UNDER HEAT)
# ═══════════════════════════════════════════════════════════════════════════
story.append(PageBreak())
story.append(SP(2.2))
story.append(P("TRUST IS EARNED UNDER HEAT", LABEL))
story.append(SP(0.4))
story.append(P("CRUCIBLE", st("CLOSE", fontSize=42, textColor=GOLD, fontName="Helvetica-Bold", leading=48, spaceAfter=8, alignment=1, letterSpacing=6)))
story.append(SP(0.1))
story.append(P("crucible.svalley.tech  ·  github.com/BROCKUGANDA/crucible", st("CLOSE2", fontSize=10, textColor=CREAM, alignment=1, spaceAfter=2)))
story.append(SP(0.3))
story.append(gold_rule())
story.append(P("Colosseum Crypto World's Fair · Ethereum Track · 2,363 tests · CI green · 15/15 edge gate · Native ETH · 5% fee · Conservation to the wei · Not financial advice · Illustrative projections only", SMALL))

doc.build(story)
print("PDF generated: Crucible_Pitch_Deck.pdf")
