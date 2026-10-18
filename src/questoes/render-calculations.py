#!/usr/bin/env python3
"""Renderiza a memória de cálculo revisada em PNG legível."""

import json
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def font(size):
    for name in ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(name).exists():
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def wrap(draw, value, selected_font, max_width):
    lines = []
    current = ""
    for word in value.split():
        proposal = f"{current} {word}".strip()
        if current and draw.textlength(proposal, font=selected_font) > max_width:
            lines.append(current)
            current = word
        else:
            current = proposal
    if current:
        lines.append(current)
    return lines


def render(batch_path):
    batch_path = Path(batch_path)
    data = json.loads(batch_path.read_text(encoding="utf-8"))
    image_dir = batch_path.parent.parent / "imagens"
    image_dir.mkdir(parents=True, exist_ok=True)
    title_font = font(30)
    body_font = font(25)
    for question in data["questions"]:
        if question["status"] != "comentada" or not question.get("calculation_steps"):
            continue
        steps = [str(step).strip() for step in question["calculation_steps"] if str(step).strip()]
        if not steps or any(len(step) > 130 for step in steps):
            question["status"] = "revisar_sem_comentario"
            question["hold_reason"] = "memoria_de_calculo_invalida"
            question["comment_markdown"] = None
            continue
        name = re.sub(r"[^a-zA-Z0-9_-]", "_", question["external_id"]) + ".png"
        target = image_dir / name
        measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        lines = [line for index, step in enumerate(steps, start=1)
                 for line in wrap(measure, f"{index}. {step}", body_font, 1310)]
        canvas = Image.new("RGB", (1400, 100 + 48 * len(lines)), "#ffffff")
        draw = ImageDraw.Draw(canvas)
        draw.text((36, 24), "Memória de cálculo", font=title_font, fill="#1f2937")
        for index, line in enumerate(lines):
            draw.text((44, 96 + 48 * index), line, font=body_font, fill="#111827")
        canvas.save(target, format="PNG", optimize=True)
        question["calculation_image"] = str(target)
        if "![Memória de cálculo]" not in question["comment_markdown"]:
            question["comment_markdown"] += f"\n\n![Memória de cálculo]({target.as_posix()})"
    temp = batch_path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(batch_path)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Uso: render-calculations.py <lote.json>")
    render(sys.argv[1])
