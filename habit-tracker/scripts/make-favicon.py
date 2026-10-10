# -*- coding: utf-8 -*-
# 生成 assets/favicon.png —— 琥珀金圆角底 + 白色对勾（Day 24 修复 favicon 404）
# 用法：python make-favicon.py <输出路径>
# 设计：底色取主题色琥珀金 #E6A23C；对勾=打卡完成，与「自律计划」语义呼应。
#       32x32 为主尺寸（浏览器标签栏会自动缩放到 16x16，故对勾画得够粗）。
#       用 8 倍超采样再缩回，得到抗锯齿边缘（PIL 直接画 32px 会有锯齿）。
import sys
from PIL import Image, ImageDraw

N = 32
S = 8                                   # 超采样倍数
W = N * S
ACCENT = (230, 162, 60, 255)            # #E6A23C 琥珀金
WHITE = (255, 255, 255, 255)

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形底（radius 约 23%，视觉上是柔和的圆角方块，不是正圆）
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(7.5 * S), fill=ACCENT)

# 白色对勾：三段折线，拐角圆滑
p1 = (8.2 * S, 16.8 * S)
p2 = (13.6 * S, 22.4 * S)
p3 = (23.8 * S, 10.2 * S)
lw = int(4.6 * S)
d.line([p1, p2, p3], fill=WHITE, width=lw, joint='curve')
r = lw / 2.0                             # 两端补圆头，避免出现方角
for p in (p1, p3):
    d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=WHITE)

out = img.resize((N, N), Image.LANCZOS)
target = sys.argv[1] if len(sys.argv) > 1 else 'favicon.png'
out.save(target, 'PNG', optimize=True)
print('已生成:', target, out.size, 'mode=', out.mode)
