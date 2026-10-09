#!/usr/bin/env python3
"""make-video-cards.py — render the title, section and closing cards for the
submission videos with Pillow, using the same vendored fonts and the same token
colours the app itself uses (src/styles/tokens.css). A video that opens on a card
drawn in the brand's own metal is a video that looks like the product.

    python scripts/make-video-cards.py

Writes PNGs into docs/media/cards/. Cards are rendered at 1920x1080; the screen
recording is upscaled to match in the ffmpeg pass that assembles the final video.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, "apps", "web", "scripts", "fonts")
OUT = os.path.join(ROOT, "docs", "media", "cards")
os.makedirs(OUT, exist_ok=True)

W, H = 1920, 1080

# The token layer, verbatim.
BG0 = (11, 10, 9)
BG1 = (21, 18, 16)
EMBER = (226, 97, 47)
GOLD = (227, 178, 92)
HOT = (251, 238, 218)
DIM = (191, 177, 153)
FAINT = (158, 144, 120)
BRONZE = (140, 107, 63)


def font(name: str, size: int, weight_axis: int | None = None) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(os.path.join(FONTS, name), size)
    if weight_axis is not None:
        try:
            f.set_variation_by_axes([weight_axis])
        except Exception:
            pass  # a static face is fine; weight is a preference, not a fact
    return f


def tracked(draw: ImageDraw.ImageDraw, xy, text: str, f, fill, tracking: float = 0.0, anchor_center_x: int | None = None):
    """Draw text letter by letter so tracking can be set the way CSS sets it."""
    if tracking <= 0:
        draw.text(xy, text, font=f, fill=fill)
        return draw.textlength(text, font=f)
    x, y = xy
    total = sum(draw.textlength(ch, font=f) + tracking for ch in text) - tracking
    if anchor_center_x is not None:
        x = anchor_center_x - total / 2
    for ch in text:
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f) + tracking
    return total


def tracked_width(draw, text, f, tracking=0.0):
    if tracking <= 0:
        return draw.textlength(text, font=f)
    return sum(draw.textlength(ch, font=f) + tracking for ch in text) - tracking


def radial_glow(size, center, radius, color, peak_alpha):
    """A soft radial pool of light, used the way body::before uses the heat pools."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    # A high-res ramp so the pool has no visible seam where the 256px default would band.
    ramp = Image.radial_gradient("L").resize((radius * 2, radius * 2), Image.BICUBIC)
    mask = Image.new("L", size, 0)
    mask.paste(ramp, (center[0] - radius, center[1] - radius))
    mask = mask.filter(ImageFilter.GaussianBlur(radius / 24))
    solid = Image.new("RGBA", size, color + (0,))
    solid.putalpha(mask.point(lambda v: int(v * peak_alpha / 255)))
    layer.alpha_composite(solid)
    return layer


def canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (W, H), BG0 + (255,))
    # Two counter-breathing pools: ember top-right of centre, gold low-left.
    img.alpha_composite(radial_glow((W, H), (int(W * 0.5), int(H * 1.02)), int(W * 0.55), EMBER, 70))
    img.alpha_composite(radial_glow((W, H), (int(W * 0.08), int(H * 0.1)), int(W * 0.4), GOLD, 26))
    return img, ImageDraw.Draw(img)


def gradient_wordmark(draw: ImageDraw.ImageDraw, text: str, f, cx: int, y: int, tracking: float = 0.0) -> int:
    """The wordmark: Cinzel capitals cut by a molten gradient, as .wordmark is."""
    width = tracked_width(draw, text, f, tracking)
    x0 = cx - width / 2
    # Paint the ramp across the glyph box: ember ignites, gold is the value, hot is the pour.
    ramp = Image.new("RGBA", (max(int(width), 2), f.size))
    rd = ImageDraw.Draw(ramp)
    span = ramp.width
    for x in range(span):
        t = x / max(span - 1, 1)
        if t < 0.52:
            k = t / 0.52
            col = tuple(int(EMBER[i] + (GOLD[i] - EMBER[i]) * k) for i in range(3))
        else:
            k = (t - 0.52) / 0.48
            col = tuple(int(GOLD[i] + (HOT[i] - GOLD[i]) * k) for i in range(3))
        rd.line([(x, 0), (x, f.size)], fill=col + (255,))
    # The glyph mask, stamped from the same draw so tracking matches.
    mask = Image.new("L", ramp.size, 0)
    md = ImageDraw.Draw(mask)
    if tracking <= 0:
        md.text((0, 0), text, font=f, fill=255)
    else:
        x = 0
        for ch in text:
            md.text((x, 0), ch, font=f, fill=255)
            x += md.textlength(ch, font=f) + tracking
    out = Image.new("RGBA", ramp.size, (0, 0, 0, 0))
    out.paste(ramp, (0, 0), mask)
    return out, int(x0), y, int(width)


def paste_wordmark(img, out, x, y):
    # A hot bloom behind the metal, the way the hero word's drop-shadow reads.
    glow = out.split()[3].filter(ImageFilter.GaussianBlur(18))
    bloom = Image.new("RGBA", out.size, EMBER + (0,))
    bloom.putalpha(glow.point(lambda v: int(v * 0.35)))
    img.alpha_composite(bloom, (x, y))
    img.alpha_composite(out, (x, y))


def mono_kicker(draw, text, cy, color=FAINT, size=30, tracking=10, cx=W // 2):
    f = font("JetBrainsMono-var.ttf", size, 500)
    tracked(draw, (0, cy), text, f, color, tracking, anchor_center_x=cx)


def body(draw, text, cy, color=DIM, size=34, cx=W // 2, width_chars=None):
    f = font("BricolageGrotesque-var.ttf", size, 400)
    draw.text((cx, cy), text, font=f, fill=color, anchor="ma")


# ─────────────────────────────────────────────────────────── card 1: demo title
def demo_title():
    img, draw = canvas()
    out, x, y, w = gradient_wordmark(draw, "CRUCIBLE", font("Cinzel[wght].ttf", 190, 700), W // 2, 330, tracking=18)
    paste_wordmark(img, out, x, y)
    draw = ImageDraw.Draw(img)
    mono_kicker(draw, "A PROVING GROUND FOR AI AGENTS", 590, color=HOT, size=34, tracking=12)
    body(draw, "Sponsors escrow rewards. Agents stake bonds. Skeptics get paid to break claims.", 700, DIM, 36)
    body(draw, "Reputation mints only from what survived.", 752, DIM, 36)
    mono_kicker(draw, "LIVE DEMO · CRUCIBLE.SVALLEY.TECH", 900, color=FAINT, size=28, tracking=8)
    # A hairline under the block, bronze like the hall rule.
    draw.line([(W // 2 - 260, 960), (W // 2 + 260, 960)], fill=BRONZE + (255,), width=2)
    mono_kicker(draw, "COLOSSEUM CRYPTO WORLD'S FAIR · ETHEREUM TRACK", 986, color=FAINT, size=26, tracking=6)
    img.convert("RGB").save(os.path.join(OUT, "demo-title.png"))


# ────────────────────────────────────────────────────────── card 2: demo closing
def demo_closing():
    img, draw = canvas()
    out, x, y, w = gradient_wordmark(draw, "SEE IT FOR YOURSELF", font("Cinzel[wght].ttf", 96, 700), W // 2, 300, tracking=10)
    paste_wordmark(img, out, x, y)
    draw = ImageDraw.Draw(img)
    f_mono = font("JetBrainsMono-var.ttf", 34, 500)
    f_label = font("JetBrainsMono-var.ttf", 24, 500)
    f_body = font("BricolageGrotesque-var.ttf", 32, 400)

    rows = [
        ("LIVE", "https://crucible.svalley.tech"),
        ("LOCAL", "npm install && npm run demo   ·   whole loop in ~90s"),
        ("CODE", "github.com/BROCKUGANDA/crucible   ·   MIT"),
    ]
    y = 520
    for label, value in rows:
        draw.text((W // 2 - 430, y + 6), label, font=f_label, fill=FAINT)
        draw.text((W // 2 - 300, y), value, font=f_mono, fill=HOT)
        y += 62
    draw.line([(W // 2 - 430, y + 14), (W // 2 + 430, y + 14)], fill=BRONZE + (120,), width=1)
    body(draw, "Trust is earned under heat.", y + 60, GOLD, 38)
    img.convert("RGB").save(os.path.join(OUT, "demo-closing.png"))


# ─────────────────────────────────────────────────────────── pitch: team + build
def pitch_cards():
    # Pitch 1 — the team, plainly.
    img, draw = canvas()
    out, x, y, w = gradient_wordmark(draw, "OTEMA ANDREW", font("Cinzel[wght].ttf", 120, 700), W // 2, 330, tracking=8)
    paste_wordmark(img, out, x, y)
    draw = ImageDraw.Draw(img)
    mono_kicker(draw, "SOLO BUILDER · FULL-STACK · ETHEREUM", 520, color=HOT, size=30, tracking=10)
    body(draw, "I build systems where the trust is mechanical, not promised.", 640, DIM, 36)
    body(draw, "Contracts, apps, agents, and the infra that keeps them honest.", 700, DIM, 36)
    mono_kicker(draw, "PITCH · 2 MINUTES", 880, color=FAINT, size=26, tracking=8)
    img.convert("RGB").save(os.path.join(OUT, "pitch-1-team.png"))

    # A reusable text card for the pitch beats.
    def card(kicker: str, title: str, lines: list[str], fname: str, accent=GOLD):
        img, draw = canvas()
        mono_kicker(draw, kicker, 220, color=accent, size=28, tracking=10)
        f_title = font("Cinzel[wght].ttf", 92, 700)
        tracked(draw, (0, 300), title, f_title, HOT, 6, anchor_center_x=W // 2)
        f_body = font("BricolageGrotesque-var.ttf", 38, 400)
        y = 500
        for line in lines:
            draw.text((W // 2, y), line, font=f_body, fill=DIM, anchor="ma")
            y += 72
        img.convert("RGB").save(os.path.join(OUT, fname))

    card(
        "THE PROBLEM",
        "DEMOS ARE NOT PROOF",
        [
            "AI agents ship with a video and vibes.",
            "Hiring one means trusting a claim you cannot test,",
            "and a reputation you cannot audit.",
        ],
        "pitch-2-problem.png",
        accent=EMBER,
    )
    card(
        "WHAT CRUCIBLE IS",
        "A PROVING GROUND",
        [
            "Sponsors escrow a bounty and pin a test suite.",
            "Agents stake a bond and sign what they built.",
            "Paid skeptics stake to falsify the claim.",
        ],
        "pitch-3-what.png",
    )
    card(
        "THE MECHANISM",
        "ATTACK PAID, NOT POLITE",
        [
            "A break that lands takes the bond — 30% to the skeptic.",
            "A run that survives pays the agent and mints Alloy.",
            "Disputes settle by commit-reveal, two of three seats.",
        ],
        "pitch-4-mechanism.png",
    )
    card(
        "WHY ME",
        "SHIPPED, NOT SKETCHED",
        [
            "560 tests: escrow conservation, EIP-712 replay, invariants.",
            "A real agent loop against a real model in a real sandbox.",
            "Live chain, live API, live app — all on one command.",
        ],
        "pitch-5-why.png",
    )
    card(
        "WHAT'S NEXT",
        "THE MARKET IS PAYING NOW",
        [
            "Human verification is a billion-dollar line item.",
            "Crucible reprices it with escrow and instant payout.",
            "Every judgment carries an on-chain receipt.",
        ],
        "pitch-6-next.png",
    )
    # Closing card, same metal as the demo's.
    img, draw = canvas()
    out, x, y, w = gradient_wordmark(draw, "TRUST IS EARNED UNDER HEAT", font("Cinzel[wght].ttf", 74, 700), W // 2, 420, tracking=8)
    paste_wordmark(img, out, x, y)
    draw = ImageDraw.Draw(img)
    mono_kicker(draw, "CRUCIBLE.SVALLEY.TECH", 620, color=HOT, size=32, tracking=10)
    mono_kicker(draw, "OTEMA ANDREW · COLOSSEUM CRYPTO WORLD'S FAIR", 740, color=FAINT, size=24, tracking=6)
    img.convert("RGB").save(os.path.join(OUT, "pitch-7-close.png"))


# ───────────────────────────────────────────────────────── caption bars (demo)
def captions():
    """The demo's narration, burned in as brand-typed bars.

    A subtitle track would need a font libass can find on a judge's machine; a PNG
    overlay drawn with the vendored JetBrains Mono cannot drift. Each bar is a
    small dark plate with a bronze hairline, so it reads over the arena scene
    without hiding it.
    """
    beats = [
        ("01", "Crucible — a proving ground for AI agents"),
        ("02", "Six acts, one screen each — the contract's own sequence"),
        ("03", "Agents stake a bond. A claim is signed, and falsifiable."),
        ("04", "The skeptic window — anyone may stake against a claim"),
        ("05", "Alloy mints only from outcomes that survived"),
        ("06", "Trials — every row is a real trial on chain"),
        ("07", "Spec · runs · breaks · verdict — each quoted from the chain"),
        ("08", "The Hall of Alloy — every row cites its settlement transaction"),
        ("09", "The Break — paid, staked skepticism"),
        ("10", "The Forge — register an agent, sign with your wallet"),
        ("11", "Docs — the rules, in the open"),
    ]
    f = font("JetBrainsMono-var.ttf", 30, 500)
    for name, text in beats:
        bar = Image.new("RGBA", (W, 96), (0, 0, 0, 0))
        d = ImageDraw.Draw(bar)
        tw = tracked_width(d, text, f, 1.5)
        x0 = (W - tw) / 2
        d.rectangle([x0 - 28, 12, x0 + tw + 28, 84], fill=(11, 10, 9, 205), outline=BRONZE + (110,), width=1)
        tracked(d, (x0, 30), text, f, HOT + (255,), 1.5)
        bar.save(os.path.join(OUT, f"caption-{name}.png"))


if __name__ == "__main__":
    demo_title()
    demo_closing()
    pitch_cards()
    captions()
    print(f"cards written to {OUT}")
