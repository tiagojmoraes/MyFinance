#!/usr/bin/env python3
# Gera os ícones nativos e o splash da marca MyFinance.
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(BASE), "assets")
os.makedirs(ASSETS, exist_ok=True)

# Paleta do app (src/theme): esmeralda #059669 (primária) com degradê para #036c50
TOP = (5, 150, 105)
BOTTOM = (2, 92, 66)
WHITE = (255, 255, 255)
SOFT = (167, 243, 208)


def vertical_gradient(w, h, top, bottom):
    img = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(top[0] + (bottom[0] - top[0]) * t)
        g = int(top[1] + (bottom[1] - top[1]) * t)
        b = int(top[2] + (bottom[2] - top[2]) * t)
        d.line([(0, y), (w, y)], fill=(r, g, b))
    return img


def load_font(size):
    for cand in (
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if os.path.exists(cand):
            return ImageFont.truetype(cand, size)
    return ImageFont.load_default()


def draw_centered(d, text, y, size, fill, w, font=None, tracking=0):
    f = font or load_font(size)
    bbox = d.textbbox((0, 0), text, font=f)
    tw = bbox[2] - bbox[0]
    d.text(((w - tw) / 2 - bbox[0], y), text, font=f, fill=fill)
    return y + size + int(size * 0.25)


def rounded_rect(d, xy, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def draw_coin(d, cx, cy, r, face=WHITE, ring=SOFT):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=face, outline=ring, width=max(2, r // 8))
    f = load_font(int(r * 1.1))
    bbox = d.textbbox((0, 0), "$", font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), "$", font=f, fill=TOP)


def draw_wallet_art(image):
    d = ImageDraw.Draw(image)
    rounded_rect(d, (192, 392, 832, 712), 56, fill=WHITE)
    rounded_rect(d, (240, 488, 784, 664), 36, fill=(224, 245, 233))
    rounded_rect(d, (600, 508, 760, 648), 32, fill=TOP)
    draw_coin(d, 360, 320, 64)
    draw_coin(d, 512, 260, 76)
    draw_coin(d, 664, 320, 64)


# ---------------------------------------------------- app icons (1024×1024) ----
S = 1024
foreground = Image.new("RGBA", (S, S), (0, 0, 0, 0))
draw_wallet_art(foreground)
foreground.save(os.path.join(ASSETS, "adaptive-icon.png"))

icon = vertical_gradient(S, S, TOP, BOTTOM).convert("RGBA")
icon.alpha_composite(foreground)
icon.save(os.path.join(ASSETS, "icon.png"))
icon.save(os.path.join(ASSETS, "splash-icon.png"))

# ------------------------------------- splash (1242×2436, tela inteira) ----
W, H = 1242, 2436
splash = vertical_gradient(W, H, TOP, BOTTOM)
d = ImageDraw.Draw(splash)

art = foreground.resize((768, 768), Image.Resampling.LANCZOS)
splash_rgba = splash.convert("RGBA")
splash_rgba.alpha_composite(art, (W // 2 - 384, H // 2 - 620))
d = ImageDraw.Draw(splash_rgba)
draw_centered(d, "MyFinance", H // 2 + 280, 128, WHITE, W)

splash_rgba.convert("RGB").save(os.path.join(ASSETS, "splash.png"))
print("OK: icon.png, adaptive-icon.png, splash-icon.png, splash.png")
