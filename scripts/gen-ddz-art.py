# -*- coding: utf-8 -*-
"""斗地主美术生成器。

跑一次产出斗地主牌桌需要的全部图片资源，不依赖任何外部素材包：

  1. 从 Wikimedia Commons 的公有领域牌面 SVG 里切出 52 张牌，拼成雪碧图；
  2. 程序化画出桌布、木质边框、牌背、头像框、按钮、筹码等 UI 元件。

用法（在仓库根目录执行）：
    python scripts/gen-ddz-art.py

依赖：
    · Python 3（标准库）
    · Pillow        —— 切图、拼图、绘制 UI 元件
    · Chrome / Edge —— 把牌面矢量图光栅化（headless 截图，不需要额外的图形库）

产物全部写进 public/ddz/：
    cards.png        54 张牌面雪碧图（含大小王）
    cards.json       每张牌在雪碧图中的格子坐标
    felt.jpg         桌布
    frame.png        木质外框
    ui/*.png         按钮、牌背、头像、徽章等
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.request import ProxyHandler, Request, build_opener

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'public', 'ddz')
UI_DIR = os.path.join(OUT_DIR, 'ui')
WORK_DIR = os.path.join(ROOT, '.tmp', 'ddz-art')

# ── 牌面源文件 ──
# Wikimedia Commons「English pattern playing cards deck」（Dmitry Fomin，公有领域）。
# 整副牌平铺在一张 5100x2310 的 SVG 上：牌面 360x540，格距 390x570，左上留白 30px，
# 13 列依次是 A,2,…,10,J,Q,K，4 行依次是黑桃、红心、方块、梅花。
DECK_URL = ('https://upload.wikimedia.org/wikipedia/commons/8/81/'
            'English_pattern_playing_cards_deck.svg')
DECK_W, DECK_H = 5100, 2310
CARD_W, CARD_H = 360, 540
CELL_DX, CELL_DY = 390, 570
MARGIN = 30

SUITS = ('spade', 'heart', 'club', 'diamond')       # 出牌显示顺序
RANKS = ('A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K')
ROW_SUIT = ('spade', 'heart', 'diamond', 'club')    # 原图 4 行的花色

TILE_W, TILE_H = 128, 192     # 雪碧图每格像素（2x 于显示尺寸，高分屏清晰）
COLS = 8

FELT_DARK = (6, 44, 31)
WOOD_DARK = (58, 32, 14)
WOOD_MID = (110, 66, 28)
WOOD_LIGHT = (168, 112, 52)
GOLD_DARK = (140, 96, 20)
GOLD_MID = (209, 162, 52)
GOLD_LIGHT = (247, 219, 130)


def log(msg: str) -> None:
    print(f'  {msg}')


# ══════════════════════════════════════════════════════════════════
#  一、浏览器
# ══════════════════════════════════════════════════════════════════

BROWSERS = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]


def find_browser() -> str:
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    for name in ('google-chrome', 'chromium', 'chromium-browser', 'chrome', 'msedge'):
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit(
        '找不到 Chrome / Edge —— 牌面矢量图需要浏览器来光栅化。\n'
        '装一个 Chrome 或 Edge 后重跑，或用 CHROME_BIN 指定可执行文件路径。')


def shoot(browser: str, url: str, png: str, w: int, h: int) -> Image.Image:
    """headless 截图，返回 PIL 图像。"""
    if os.path.exists(png):
        os.remove(png)
    subprocess.run(
        [browser, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
         '--force-device-scale-factor=1', f'--window-size={w},{h}',
         f'--screenshot={os.path.abspath(png)}', url],
        capture_output=True, text=True, timeout=240)
    if not os.path.exists(png):
        raise RuntimeError(f'光栅化失败：{url}')
    return Image.open(png).convert('RGB')


def fetch_deck() -> str:
    os.makedirs(WORK_DIR, exist_ok=True)
    path = os.path.join(WORK_DIR, 'deck.svg')
    if os.path.exists(path) and os.path.getsize(path) > 1_000_000:
        return path
    log('下载牌面矢量图（约 2.5MB，只需一次）…')
    proxy = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    opener = build_opener(ProxyHandler({'http': proxy, 'https': proxy})) if proxy else build_opener()
    req = Request(DECK_URL, headers={'User-Agent': 'webgame-ddz-art/1.0'})
    with open(path, 'wb') as f:
        f.write(opener.open(req, timeout=180).read())
    return path


# ══════════════════════════════════════════════════════════════════
#  二、切出 54 张牌
# ══════════════════════════════════════════════════════════════════

def build_sheet(browser: str) -> None:
    """先切牌面，再拼雪碧图。"""
    deck = fetch_deck()
    log('光栅化整副牌…')
    full = shoot(browser, 'file:///' + os.path.abspath(deck).replace('\\', '/'),
                 os.path.join(WORK_DIR, 'deck.png'), DECK_W, DECK_H)

    cards: dict[tuple[str, str], Image.Image] = {}
    for row in range(4):
        for col in range(13):
            x = MARGIN + col * CELL_DX
            y = MARGIN + row * CELL_DY
            cards[(ROW_SUIT[row], RANKS[col])] = full.crop((x, y, x + CARD_W, y + CARD_H))

    log('绘制大小王…')
    cards[('joker', 'small')] = draw_joker(browser, 'k', (40, 46, 62))
    cards[('joker', 'big')] = draw_joker(browser, 'K', (168, 30, 38))

    keys = [(s, r) for s in SUITS for r in RANKS] + [('joker', 'small'), ('joker', 'big')]
    rows = (len(keys) + COLS - 1) // COLS
    sheet = Image.new('RGBA', (COLS * TILE_W, rows * TILE_H), (0, 0, 0, 0))
    index = {}
    for i, key in enumerate(keys):
        cx, cy = (i % COLS) * TILE_W, (i // COLS) * TILE_H
        tile = cards[key].resize((TILE_W, TILE_H), Image.LANCZOS).convert('RGBA')
        sheet.alpha_composite(tile, (cx, cy))
        index[f'{key[0]}_{key[1]}'] = {'x': cx, 'y': cy, 'w': TILE_W, 'h': TILE_H}
    sheet.save(os.path.join(OUT_DIR, 'cards.png'))
    with open(os.path.join(OUT_DIR, 'cards.json'), 'w', encoding='utf-8') as f:
        json.dump({'tile': [TILE_W, TILE_H], 'cols': COLS, 'rows': rows, 'cards': index},
                  f, ensure_ascii=False, indent=1)
    log(f'cards.png {sheet.width}x{sheet.height}（{len(keys)} 张）')


JOKER_SVG = '''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="540" viewBox="0 0 360 540">
  <rect x="0" y="0" width="360" height="540" rx="30" fill="#ffffff"/>
  <g transform="translate(30,30)">
    <text x="0" y="0" font-family="Times New Roman, serif" font-size="62" font-weight="bold"
          fill="{ink}" transform="translate(0,58)">{mark}</text>
    <g transform="translate(150,240)">
      <circle cx="0" cy="0" r="86" fill="{tint}" opacity="0.12"/>
      <path d="M 0 -74 L 58 -14 L 0 74 L -58 -14 Z" fill="{tint}"/>
      <path d="M 0 -50 L 38 -12 L 0 50 L -38 -12 Z" fill="#ffffff"/>
      <path d="M 0 -26 L 18 -8 L 0 26 L -18 -8 Z" fill="{tint}"/>
      <text x="0" y="16" font-family="Georgia, serif" font-size="34" font-weight="bold"
            text-anchor="middle" fill="{tint}">{mark}</text>
    </g>
  </g>
</svg>
'''


def draw_joker(browser: str, mark: str, tint) -> Image.Image:
    svg = JOKER_SVG.format(mark=mark, tint='#%02x%02x%02x' % tint,
                           ink='#%02x%02x%02x' % tint)
    path = os.path.join(WORK_DIR, f'joker_{mark}.svg')
    open(path, 'w', encoding='utf-8').write(svg)
    return shoot(browser, 'file:///' + os.path.abspath(path).replace('\\', '/'),
                 os.path.join(WORK_DIR, f'joker_{mark}.png'), CARD_W, CARD_H)


# ══════════════════════════════════════════════════════════════════
#  三、程序化 UI 元件
# ══════════════════════════════════════════════════════════════════

def radial(size, inner, outer, r=0.85):
    """径向渐变 —— 桌布中央的聚光。"""
    w, h = size
    img = Image.new('RGB', size)
    px = img.load()
    ox, oy = w / 2, h / 2
    rr = r * max(w, h)
    for y in range(h):
        for x in range(w):
            t = min(1.0, math.hypot(x - ox, y - oy) / rr) ** 2
            px[x, y] = (int(inner[0] + (outer[0] - inner[0]) * t),
                        int(inner[1] + (outer[1] - inner[1]) * t),
                        int(inner[2] + (outer[2] - inner[2]) * t))
    return img


def make_felt(w, h, seed=7):
    """桌布：深绿绒布 + 中央聚光 + 细颗粒。"""
    import random
    base = radial((w, h), (30, 118, 84), (6, 44, 31))
    rng = random.Random(seed)
    noise = Image.new('L', (w, h))
    noise.putdata([128 + rng.randint(-7, 7) for _ in range(w * h)])
    out = Image.blend(base, Image.merge('RGB', (noise, noise, noise)), 0.09)
    glow = Image.new('L', (w, h), 0)
    ImageDraw.Draw(glow).ellipse([w * 0.16, h * 0.08, w * 0.84, h * 0.70], fill=74)
    glow = glow.filter(ImageFilter.GaussianBlur(max(w, h) // 10))
    return Image.composite(Image.new('RGB', (w, h), (38, 134, 97)), out, glow)


def round_mask(size, radius):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius, fill=255)
    return m


def make_wood_frame(w, h, thickness=24, radius=36):
    """木质外框：木纹 + 内侧阴影，中心透明，直接罩在桌布上。"""
    import random
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius, fill=WOOD_MID + (255,))
    rng = random.Random(11)
    for i in range(0, w, 2):
        c = tuple(max(0, min(255, v + rng.randint(-30, 24))) for v in WOOD_MID)
        d.line([(i, 0), (i, h)], fill=c + (255,), width=1)
    for i in range(0, h, 2):
        c = tuple(max(0, min(255, v + rng.randint(-24, 18))) for v in WOOD_MID)
        d.line([(0, i), (w, i)], fill=c + (255,), width=1)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius, outline=WOOD_LIGHT + (180,), width=2)
    d.rounded_rectangle([3, 3, w - 4, h - 4], radius - 3, outline=WOOD_DARK + (210,), width=3)
    hole_r = max(0, radius - thickness + 6)
    hole = Image.new('L', (w, h), 0)
    ImageDraw.Draw(hole).rounded_rectangle(
        [thickness, thickness, w - thickness - 1, h - thickness - 1], hole_r, fill=255)
    img.putalpha(Image.composite(Image.new('L', (w, h), 0), img.getchannel('A'),
                                 hole.filter(ImageFilter.GaussianBlur(3))))
    edge = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        [thickness, thickness, w - thickness - 1, h - thickness - 1], hole_r,
        outline=(0, 0, 0, 120), width=7)
    return Image.alpha_composite(img, edge.filter(ImageFilter.GaussianBlur(4)))


def make_back(w=TILE_W, h=TILE_H, radius=10):
    """牌背：深红底 + 金色回纹 + 菱形暗格。"""
    s = 4
    W, H = w * s, h * s
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], radius * s, fill=(120, 26, 34, 255))
    for k in range(-H, W + H, 18 * s):
        d.line([(k, 0), (k + H, H)], fill=(148, 42, 50, 255), width=s)
        d.line([(k, H), (k + H, 0)], fill=(148, 42, 50, 255), width=s)
    inset = 7 * s
    d.rounded_rectangle([inset, inset, W - inset - 1, H - inset - 1],
                        int(radius * s * 0.62), outline=(212, 170, 72, 255), width=2 * s)
    d.rounded_rectangle([inset + 3 * s, inset + 3 * s, W - inset - 3 * s - 1,
                         H - inset - 3 * s - 1], int(radius * s * 0.5),
                        outline=(240, 214, 142, 180), width=s)
    cx, cy = W / 2, H / 2
    rr = min(W, H) * 0.20
    d.polygon([(cx, cy - rr), (cx + rr * 0.68, cy), (cx, cy + rr), (cx - rr * 0.68, cy)],
              fill=(212, 170, 72, 255))
    d.polygon([(cx, cy - rr * 0.60), (cx + rr * 0.41, cy), (cx, cy + rr * 0.60),
               (cx - rr * 0.41, cy)], fill=(120, 26, 34, 255))
    img = img.resize((w, h), Image.LANCZOS)
    img.putalpha(round_mask((w, h), radius))
    return img


def make_avatar(name, size=96, bg=(70, 132, 196)):
    """座位头像：程序化画的小人。"""
    s = 3
    S = size * s
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, S - 1, S - 1], fill=bg + (255,))
    d.ellipse([int(S * 0.12), int(S * 0.62), int(S * 0.88), int(S * 1.22)],
              fill=(240, 238, 233, 255))
    d.ellipse([int(S * 0.27), int(S * 0.17), int(S * 0.73), int(S * 0.67)],
              fill=(246, 219, 186, 255))
    d.pieslice([int(S * 0.25), int(S * 0.11), int(S * 0.75), int(S * 0.53)],
               180, 360, fill=(46, 38, 34, 255))
    d.ellipse([int(S * 0.38), int(S * 0.37), int(S * 0.45), int(S * 0.44)], fill=(40, 36, 34, 255))
    d.ellipse([int(S * 0.55), int(S * 0.37), int(S * 0.62), int(S * 0.44)], fill=(40, 36, 34, 255))
    d.arc([int(S * 0.43), int(S * 0.44), int(S * 0.57), int(S * 0.57)], 20, 160,
          fill=(158, 66, 66, 255), width=int(1.5 * s))
    img = img.resize((size, size), Image.LANCZOS)
    img.putalpha(round_mask((size, size), size // 2))
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_ring(name, size=112, gold=False):
    """头像框：木质圆环 + 金属内圈（地主款用金色）。

    必须是**中空**的环 —— 头像是单独一层垫在下面，实心圆盘会把它整个盖住。"""
    s = 3
    S = size * s
    outer = GOLD_LIGHT if gold else WOOD_LIGHT
    mid = GOLD_MID if gold else WOOD_MID
    dark = GOLD_DARK if gold else WOOD_DARK
    pad = 3 * s
    ring_w = 9 * s                      # 环的厚度

    # 只画环：外圆减去内圆
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.ellipse([pad, pad, S - pad - 1, S - pad - 1], fill=255)
    md.ellipse([pad + ring_w, pad + ring_w, S - pad - ring_w - 1, S - pad - ring_w - 1], fill=0)

    body = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.ellipse([pad, pad, S - pad - 1, S - pad - 1], fill=mid + (255,))
    body.putalpha(Image.composite(body.getchannel('A'), Image.new('L', (S, S), 0), mask))

    # 环上的高光与描边
    d = ImageDraw.Draw(body)
    d.ellipse([pad, pad, S - pad - 1, S - pad - 1], outline=dark + (255,), width=2 * s)
    d.ellipse([pad + 3 * s, pad + 3 * s, S - pad - 3 * s - 1, S - pad - 3 * s - 1],
              outline=outer + (200,), width=s)
    d.ellipse([pad + ring_w - s, pad + ring_w - s, S - pad - ring_w + s - 1,
               S - pad - ring_w + s - 1], outline=dark + (200,), width=s)
    img = body.resize((size, size), Image.LANCZOS)
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_crown(name='crown', size=80):
    """地主帽：金冠。"""
    s = 4
    W, H = size * s, int(size * 0.66) * s
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(W * 0.06, H * 0.94), (W * 0.94, H * 0.94), (W * 0.86, H * 0.30),
               (W * 0.66, H * 0.62), (W * 0.50, H * 0.10), (W * 0.34, H * 0.62),
               (W * 0.14, H * 0.30)], fill=GOLD_MID + (255,), outline=GOLD_DARK + (255,))
    d.line([(W * 0.06, H * 0.94), (W * 0.94, H * 0.94)], fill=GOLD_LIGHT + (255,),
           width=max(2, int(2.5 * s)))
    for cx in (0.14, 0.50, 0.86):
        d.ellipse([W * cx - 5 * s, H * 0.24 - 5 * s, W * cx + 5 * s, H * 0.24 + 5 * s],
                  fill=(226, 62, 62, 255), outline=GOLD_DARK + (255,), width=s)
    img = img.resize((size, int(size * 0.66)), Image.LANCZOS)
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_btn(name, w, h, top, bottom, border, radius=None):
    """按钮底：立体渐变 + 顶部高光 + 描边。"""
    s = 3
    W, H = w * s, h * s
    r = (radius or h // 2) * s
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / max(1, H - 1)
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t)
                                            for i in range(3)) + (255,))
    img.putalpha(round_mask((W, H), r))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], r, outline=border + (255,), width=max(2, 2 * s))
    d.rounded_rectangle([3 * s, 2 * s, W - 3 * s - 1, int(H * 0.48)], int(r * 0.8),
                        outline=(255, 255, 255, 70), width=max(1, s))
    img = img.resize((w, h), Image.LANCZOS)
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_badge(name, w, h, bg, radius=None):
    s = 4
    W, H = w * s, h * s
    r = (radius if radius is not None else h // 2) * s
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, W - 1, H - 1], r, fill=bg + (255,))
    d.rounded_rectangle([0, 0, W - 1, H - 1], r, outline=(0, 0, 0, 130), width=max(1, s))
    d.rounded_rectangle([2 * s, s, W - 2 * s - 1, int(H * 0.5)], int(r * 0.75),
                        outline=(255, 255, 255, 60), width=max(1, s))
    img = img.resize((w, h), Image.LANCZOS)
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_chip(name, size=44, color=(198, 44, 44)):
    s = 4
    S = size * s
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, S - 1, S - 1], fill=(238, 236, 230, 255), outline=(60, 50, 44, 255),
              width=int(1.4 * s))
    for k in range(12):
        a0 = k * 30 + 4
        d.pieslice([int(2.2 * s), int(2.2 * s), S - int(2.2 * s) - 1, S - int(2.2 * s) - 1],
                   a0, a0 + 22, fill=color + (255,))
    d.ellipse([int(6 * s), int(6 * s), S - int(6 * s) - 1, S - int(6 * s) - 1],
              fill=color + (255,))
    d.ellipse([int(9 * s), int(9 * s), S - int(9 * s) - 1, S - int(9 * s) - 1],
              fill=(250, 248, 242, 255))
    img = img.resize((size, size), Image.LANCZOS)
    return img.save(os.path.join(UI_DIR, f'{name}.png'))


def make_glow(name, size=192, color=(255, 226, 140)):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([4, 4, size - 5, size - 5], fill=color + (150,))
    img.filter(ImageFilter.GaussianBlur(size // 8)).save(os.path.join(UI_DIR, f'{name}.png'))


def make_timer_ring(name, size=64, color=(255, 214, 92)):
    s = 4
    S = size * s
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([0, 0, S - 1, S - 1], outline=(0, 0, 0, 90), width=int(3.5 * s))
    d.arc([0, 0, S - 1, S - 1], -90, 200, fill=color + (255,), width=int(3.5 * s))
    img.resize((size, size), Image.LANCZOS).save(os.path.join(UI_DIR, f'{name}.png'))


def build_ui() -> None:
    log('绘制 UI 元件…')
    os.makedirs(UI_DIR, exist_ok=True)
    make_felt(760, 560).save(os.path.join(OUT_DIR, 'felt.jpg'), quality=88)
    make_wood_frame(760, 560).save(os.path.join(OUT_DIR, 'frame.png'))
    make_back().save(os.path.join(UI_DIR, 'card-back.png'))
    make_glow('glow')
    make_timer_ring('timer-ring')
    make_chip('chip-red', color=(198, 44, 44))
    make_chip('chip-blue', color=(46, 92, 172))
    make_chip('chip-gold', color=(190, 146, 40))
    make_badge('badge-gold', 96, 34, (198, 148, 40), radius=17)
    make_badge('badge-blue', 96, 34, (54, 108, 176), radius=17)
    make_avatar('avatar-you', size=96, bg=(70, 132, 196))
    make_avatar('avatar-left', size=96, bg=(78, 148, 118))
    make_avatar('avatar-right', size=96, bg=(180, 112, 76))
    make_ring('ring-wood', gold=False)
    make_ring('ring-gold', gold=True)
    make_crown()
    make_btn('btn-play', 240, 84, (232, 186, 74), (186, 128, 22), (92, 60, 10), radius=22)
    make_btn('btn-pass', 200, 74, (96, 108, 108), (54, 62, 62), (28, 32, 32), radius=20)
    make_btn('btn-hint', 200, 74, (86, 152, 216), (40, 92, 158), (22, 52, 94), radius=20)
    make_btn('btn-gold-sm', 150, 60, (232, 186, 74), (186, 128, 22), (92, 60, 10), radius=16)
    make_btn('btn-dark-sm', 150, 60, (92, 104, 104), (52, 60, 60), (28, 32, 32), radius=16)
    log('UI 元件完成')


def main() -> None:
    if not os.path.isdir(os.path.join(ROOT, 'public')):
        raise SystemExit('请在仓库根目录执行本脚本')
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(WORK_DIR, exist_ok=True)
    browser = os.environ.get('CHROME_BIN') or find_browser()
    log(f'使用浏览器：{browser}')
    build_sheet(browser)
    build_ui()
    log('全部完成 → public/ddz/')


if __name__ == '__main__':
    main()
