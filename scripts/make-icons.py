"""Render the extension toolbar icons from the same visual language as icon.svg."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension-src", "icons")
os.makedirs(OUT, exist_ok=True)
S = 512

def render():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((16, 16, S - 16, S - 16), radius=120, fill=(37, 99, 235, 255))
    # soft highlight
    d.ellipse((60, 40, 380, 240), fill=(96, 165, 250, 70))
    # cookie body
    d.ellipse((96, 96, 368, 368), fill=(253, 230, 138, 255), outline=(245, 158, 11, 255), width=14)
    # bite
    d.ellipse((300, 64, 420, 184), fill=(37, 99, 235, 255))
    # chips
    for (x, y, r) in [(164, 176, 20), (244, 144, 18), (272, 236, 20), (176, 272, 18), (220, 220, 14)]:
        d.ellipse((x - r, y - r, x + r, y + r), fill=(180, 83, 9, 255))
    # shield
    shield = [(300, 274), (404, 318), (404, 372), (352, 430), (300, 404), (248, 430), (196, 372), (196, 318)]
    # simpler shield with polygon
    shield = [(352, 268), (444, 306), (444, 356), (398, 414), (352, 444), (306, 414), (260, 356), (260, 306)]
    d.polygon(shield, fill=(255, 255, 255, 255), outline=(30, 64, 175, 255), width=8)
    # check
    d.line([(316, 352), (344, 380), (392, 324)], fill=(29, 78, 216, 255), width=22, joint="curve")
    return img

base = render()
for size in (16, 32, 48, 128):
    resized = base.resize((size, size), Image.LANCZOS)
    resized.save(os.path.join(OUT, f"icon{size}.png"), "PNG")
    print("wrote", os.path.join(OUT, f"icon{size}.png"))
