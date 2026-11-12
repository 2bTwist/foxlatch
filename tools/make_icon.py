"""Foxlatch mark (writes extension/icon.svg and extension/icon-small.svg): an ASCII-shaded globe with a keyhole.

One 16x16 master. Each cell is a character (- + x # █) on a 5x5 grid, chosen by ink
coverage to follow the light on a sphere. Two renderings of that same master:
  glyph  (96 px and up): cell = 6 px, so every stroke is a whole pixel.
  flat   (48 px and down): cell = one square of the same ink at the opacity
         equal to its character's coverage, so it matches the glyph version shrunk.
One ink at opacities, no gradients, no shadows (the opencode rules).
"""
import math, sys

RAMP = [  # character, 5x5 bitmap; coverage rises
    ("-", ".....|.....|.###.|.....|....."),
    ("+", ".....|..#..|.###.|..#..|....."),
    ("x", "#...#|.#.#.|..#..|.#.#.|#...#"),
    ("#", ".#.#.|#####|.#.#.|#####|.#.#."),
    ("█", "#####|#####|#####|#####|#####"),
]
COVER = [b.count("#") / 25 for _, b in RAMP]
TILE, INK, KEY = "#0d0e10", "#eeeeee", "#5e6ad2"
N = 16
KEYHOLE = {4: (6, 9), 5: (5, 10), 6: (5, 10), 7: (6, 9), 8: (7, 8), 9: (7, 8), 10: (7, 8), 11: (7, 8)}
LIGHT = (-0.5, -0.6, 0.62)

def level(i, j):
    """Ramp index for cell (i, j), None outside the globe, 'K' in the keyhole."""
    a, b = KEYHOLE.get(j, (99, -1))
    if a <= i <= b: return "K"
    x, y = (i + 0.5 - 8) / 7, (j + 0.5 - 8) / 7
    if x * x + y * y > 1: return None
    z = math.sqrt(1 - x * x - y * y)
    n = math.sqrt(sum(c * c for c in LIGHT))
    d = max(0.0, (x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]) / n)
    t = 0.12 + 0.88 * d ** 1.4                 # never fully dark: the dark side still draws
    return min(range(len(RAMP)), key=lambda k: abs(COVER[k] - t))

def flat():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">',
           f'<rect width="16" height="16" rx="3.5" fill="{TILE}"/>']
    for j in range(N):
        for i in range(N):
            k = level(i, j)
            if k is None: continue
            fill = f'fill="{KEY}"' if k == "K" else f'fill="{INK}" fill-opacity="{COVER[k]:.2f}"'
            out.append(f'<rect x="{i}" y="{j}" width="1" height="1" {fill}/>')
    return "\n".join(out + ["</svg>"])

def glyph():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" shape-rendering="crispEdges">',
           f'<rect width="96" height="96" rx="21" fill="{TILE}"/>']
    for j in range(N):
        for i in range(N):
            k = level(i, j)
            if k is None: continue
            bitmap, fill = (RAMP[-1][1], KEY) if k == "K" else (RAMP[k][1], INK)
            for r, row in enumerate(bitmap.split("|")):
                c = 0
                while c < 5:
                    if row[c] != "#": c += 1; continue
                    e = c
                    while e < 5 and row[e] == "#": e += 1
                    out.append(f'<rect x="{6 * i + c}" y="{6 * j + r}" width="{e - c}" height="1" fill="{fill}"/>')
                    c = e
    return "\n".join(out + ["</svg>"])

if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "extension"
    open(f"{d}/icon-small.svg", "w").write(flat())
    open(f"{d}/icon.svg", "w").write(glyph())
    for j in range(N):
        print("".join(" " if (k := level(i, j)) is None else "K" if k == "K" else RAMP[k][0] for i in range(N)))
