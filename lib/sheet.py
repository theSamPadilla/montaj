"""Tile frame PNGs into one sheet with a label under each tile (a time in seconds, or any text)."""
import os

GUTTER = 4
LABEL_H = 18


def tile_sheet(frame_paths, times, cols, tile_width, out, label_px=None, box_height=None):
    """`label_px`: the label's font size in pixels, for a sheet that is shown scaled down (a 768 px preview); left out,
    Pillow's small default font. `box_height`: fit every tile whole into tile_width x box_height (for frames of mixed
    shapes, a vertical take beside a landscape recording); left out, each tile is tile_width wide at its own shape."""
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.load_default(size=label_px) if label_px else None
    label_h = max(LABEL_H, int(label_px * 1.3)) if label_px else LABEL_H
    tiles = []
    for p in frame_paths:
        with Image.open(p) as src:
            im = src.convert("RGB")
        if box_height:   # tiles of mixed shapes: each fitted whole into the same box, on grey
            k = min(tile_width / im.size[0], box_height / im.size[1])
            fit = im.resize((max(1, int(im.size[0] * k + 0.5)), max(1, int(im.size[1] * k + 0.5))))
            boxed = Image.new("RGB", (tile_width, box_height), (64, 64, 64))
            boxed.paste(fit, ((tile_width - fit.size[0]) // 2, (box_height - fit.size[1]) // 2))
            tiles.append(boxed)
            continue
        h = int(im.size[1] * tile_width / im.size[0] + 0.5)  # round half up
        tiles.append(im.resize((tile_width, h)))
    tile_h = tiles[0].size[1]
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_width + (cols + 1) * GUTTER,
                              rows * (tile_h + label_h) + (rows + 1) * GUTTER), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for i, (t, tile) in enumerate(zip(times, tiles)):
        r, c = divmod(i, cols)
        x = GUTTER + c * (tile_width + GUTTER)
        y = GUTTER + r * (tile_h + label_h + GUTTER)
        sheet.paste(tile, (x, y))
        draw.text((x + 2, y + tile_h + 3), t if isinstance(t, str) else f"{t:.2f}s", fill=(0, 0, 0), font=font)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    sheet.save(out)
