#!/usr/bin/env python3
"""生成 PWA 图标（public/ 下的 pwa-*.png 与 apple-touch-icon.png）。

图标是「品牌色圆角方块 + 🐟」。之所以用脚本而不是手放的二进制：
品牌色或标记一改，图标能一条命令重出，不用去翻设计稿。

用法（需要 Pillow，Windows 上用系统自带的 Segoe UI Emoji 字体）：
    python scripts/generate-pwa-icons.py

只依赖标准库 + Pillow，不改动除 public/ 下图标以外的任何文件。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - 环境缺失时给出可执行提示
    sys.exit('缺少 Pillow：pip install pillow')

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'public'

BRAND = (16, 168, 140)  # #10a88c，与 index.html 的 theme-color / favicon 一致
MARK = '🐟'
EMOJI_FONTS = [
    'C:/Windows/Fonts/seguiemj.ttf',
    '/System/Library/Fonts/Apple Color Emoji.ttc',
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
]

# (文件名, 边长, 内容缩放, 是否切圆角)
# maskable 图标要做到「满出血」且主体落在中心 80% 安全区内，方便系统裁成圆形/水滴形。
TARGETS = [
    ('pwa-192.png', 192, 0.60, True),
    ('pwa-512.png', 512, 0.60, True),
    ('pwa-maskable-512.png', 512, 0.50, False),
    ('apple-touch-icon.png', 180, 0.60, False),
]


def load_mark_font(px: int) -> ImageFont.FreeTypeFont:
    for path in EMOJI_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, px)
            except OSError:
                continue
    sys.exit('找不到可用的 Emoji 字体，请把系统里的彩色 Emoji 字体路径加进 EMOJI_FONTS')


def render(size: int, mark_ratio: float, rounded: bool) -> Image.Image:
    """渲染一张图标。超采样 4 倍再缩回来，边缘才不会有锯齿。"""
    ss = 4
    px = size * ss
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if rounded:
        draw.rounded_rectangle((0, 0, px - 1, px - 1), radius=int(px * 0.22), fill=BRAND)
    else:
        draw.rectangle((0, 0, px, px), fill=BRAND)

    font = load_mark_font(int(px * mark_ratio))
    draw.text((px / 2, px * 0.52), MARK, font=font, embedded_color=True, anchor='mm')

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, ratio, rounded in TARGETS:
        path = OUT / name
        render(size, ratio, rounded).save(path, optimize=True)
        print(f'  {path.relative_to(ROOT)}  {size}x{size}  {path.stat().st_size / 1024:.1f} KB')


if __name__ == '__main__':
    main()
