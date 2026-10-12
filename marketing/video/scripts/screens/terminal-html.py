"""Turns a real terminal capture (raw bytes with ANSI codes) into an HTML page for a screenshot.
A tiny terminal: SGR colours, carriage return and cursor-column moves, clear-to-end. Nothing is
added to what the program printed except the command line on top, and redactions blur, not replace.
  python3 terminal-html.py capture.raw out.html --command "sudo local-cognitive-server" --until "› exit" --blur 'online · (.+?) connected'
"""
import argparse, html, re

parser = argparse.ArgumentParser()
parser.add_argument("raw"); parser.add_argument("out")
parser.add_argument("--command", default=""); parser.add_argument("--until", default=None)
parser.add_argument("--blur", action="append", default=[])
args = parser.parse_args()

PALETTE = {30: "#5c6370", 31: "#ff6b6b", 32: "#3ddc84", 33: "#e5c07b", 34: "#5cb4ff", 35: "#c678dd", 36: "#56d4dd", 37: "#d8e2f2",
           90: "#7d8ba1", 91: "#ff8787", 92: "#69f0ae", 93: "#ffd866", 94: "#5cb4ff", 95: "#d7a6ff", 96: "#7ee8fa", 97: "#ffffff"}
text = open(args.raw, "rb").read().decode("utf-8", "replace")
text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)          # OSC (terminal metadata)
text = re.sub(r"Connection to \S+ closed\.\s*$", "", text.strip())

lines, line, col, style = [], [], 0, {"fg": None, "bold": False}
def put(char):
    global col
    cell = (char, dict(style))
    if col < len(line): line[col] = cell
    else: line.extend([(" ", {"fg": None, "bold": False})] * (col - len(line))); line.append(cell)
    col += 1
i = 0
while i < len(text):
    c = text[i]
    if c == "\x1b":
        m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", text[i:])
        if m:
            params, kind = m.group(1), m.group(2)
            if kind == "m":
                for code in [int(x) for x in params.split(";") if x.isdigit()] or [0]:
                    if code == 0: style = {"fg": None, "bold": False}
                    elif code == 1: style["bold"] = True
                    elif code == 22: style["bold"] = False
                    elif code == 39: style["fg"] = None
                    elif code in PALETTE: style["fg"] = PALETTE[code]
            elif kind == "G": col = max(int(params or 1) - 1, 0)
            elif kind == "J" or kind == "K": del line[col:]
            i += len(m.group(0)); continue
    if c == "\r": col = 0
    elif c == "\n": lines.append(line); line, col = [], 0
    else: put(c)
    i += 1
lines.append(line)

def plain(cells): return "".join(ch for ch, _ in cells).rstrip()
if args.until:
    for n, cells in enumerate(lines):
        if plain(cells).startswith(args.until): lines = lines[:n]; break
while lines and not plain(lines[-1]): lines.pop()
while lines and not plain(lines[0]): lines.pop(0)

def render(cells):
    s = plain(cells); cells = cells[:len(s)]
    blur = [False] * len(cells)
    for pattern in args.blur:
        for m in re.finditer(pattern, s):
            for k in range(m.start(1), m.end(1)): blur[k] = True
    out, k = [], 0
    while k < len(cells):
        st, b = cells[k][1], blur[k]; j = k
        while j < len(cells) and cells[j][1] == st and blur[j] == b: j += 1
        chunk = html.escape("".join(ch for ch, _ in cells[k:j]))
        css = (f"color:{st['fg']};" if st["fg"] else "") + ("font-weight:700;" if st["bold"] else "")
        cls = ' class="blur"' if b else ""
        out.append(f'<span{cls} style="{css}">{chunk}</span>' if css or b else chunk)
        k = j
    return "".join(out)

body = "\n".join(render(cells) for cells in lines)
command = f'<span style="color:#7d8ba1">$</span> {html.escape(args.command)}\n' if args.command else ""
open(args.out, "w").write(f"""<!doctype html><meta charset="utf-8"><style>
body {{ margin: 0; background: #f6f7f9; padding: 32px; display: inline-block; }}
.term {{ background: #0f141b; color: #d8e2f2; border-radius: 14px; box-shadow: 0 30px 60px -30px rgba(15,20,27,.45); overflow: hidden; display: inline-block; }}
.bar {{ display: flex; gap: 8px; padding: 14px 18px 0; }} .bar i {{ width: 12px; height: 12px; border-radius: 50%; background: #2b3442; display: block; }}
pre {{ margin: 0; padding: 18px 28px 26px; font: 15px/1.2 "SF Mono", Menlo, Consolas, monospace; white-space: pre; }}
.blur {{ filter: blur(5px); }}
</style><div class="term"><div class="bar"><i></i><i></i><i></i></div><pre>{command}{body}</pre></div>""")
print(args.out, len(lines), "lines")
