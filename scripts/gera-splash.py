#!/usr/bin/env python3
# v70 (MELHORIA 2.2) — gera a imagem do SPLASH do app (não pode abrir em branco).
# Design: fundo verde-esmeralda (cor primária do app), cifrão/carteira estilizada
# com moedas — remete a "moderno, inteligente e útil": controle financeiro +
# despensa. Saída: assets/splash.png (1242×2436, proporção de tela Android/iOS
# moderna) e assets/splash-icon.png (1024×1024 para o centro).
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(BASE, "assets")
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


# ------------------------------------------------ splash-icon (1024×1024) ----
S = 1024
icon = vertical_gradient(S, S, TOP, BOTTOM)
d = ImageDraw.Draw(icon)

# Carteira (rounded rect) com fecho e moedas saindo — marca do app
card_x0, card_y0, card_x1, card_y1 = 192, 392, 832, 712
rounded_rect(d, (card_x0, card_y0, card_x1, card_y1), 56, fill=WHITE)
# bolso da carteira
rounded_rect(d, (card_x0 + 48, card_y0 + 96, card_x1 - 48, card_y1 - 48), 36, fill=(224, 245, 233))
# fivela
rounded_rect(d, (card_x1 - 232, card_y0 + 116, card_x1 - 96, card_y1 - 116), 28, fill=TOP)
# moedas
draw_coin(d, 360, 320, 64)
draw_coin(d, 512, 260, 76)
draw_coin(d, 664, 320, 64)
# nome + tagline
y = 768
y = draw_centered(d, "MyFinance", y, 104, WHITE, S)
draw_centered(d, "& Pantry Manager", y, 64, SOFT, S)

icon.save(os.path.join(ASSETS, "splash-icon.png"))

# ------------------------------------- splash (1242×2436, tela inteira) ----
W, H = 1242, 2436
splash = vertical_gradient(W, H, TOP, BOTTOM)
d = ImageDraw.Draw(splash)

# ícone central (reaproveita o desenho da carteira em escala)
ix0, iy0, ix1, iy1 = W // 2 - 320, H // 2 - 460, W // 2 + 320, H // 2 + 180
d.rounded_rectangle((ix0, iy0 + 200, ix1, iy1), 56, fill=WHITE)
d.rounded_rectangle((ix0 + 48, iy0 + 296, ix1 - 48, iy1 - 48), 36, fill=(224, 245, 233))
d.rounded_rectangle((ix1 - 232, iy0 + 316, ix1 - 96, iy1 - 116), 28, fill=TOP)
draw_coin(d, W // 2 - 152, iy0 + 120, 64)
draw_coin(d, W // 2, iy0 + 60, 76)
draw_coin(d, W // 2 + 152, iy0 + 120, 64)

y = H // 2 + 320
y = draw_centered(d, "MyFinance", y, 128, WHITE, W)
y = draw_centered(d, "& Pantry Manager", y, 76, SOFT, W)
draw_centered(d, "Financeiro, despensa e NFC-e — tudo no lugar.", y + 40, 44, (209, 250, 229), W)

splash.save(os.path.join(ASSETS, "splash.png"))
print("OK:", os.path.join(ASSETS, "splash.png"), os.path.join(ASSETS, "splash-icon.png"))
