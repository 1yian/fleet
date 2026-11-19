import asyncio
import io
import random
import re
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageStat
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Frame, Page
from pydantic import BaseModel, Field

from .frames import frame_visible, frame_with
from .model import OpenAIProvider
from .workdir import work_dir

MAX_CHALLENGES = 4
MAX_DYNAMIC_ROUNDS = 6
SETTLE_SECONDS = 12.0
WORK_DIR = work_dir() / "recaptcha"

SYSTEM = """You solve reCAPTCHA v2 image challenges.
The picture is a grid of tiles. Each tile has its number drawn in a small box in its top-left corner. Numbers count row by row from the top-left tile, starting at 1.
The task text is given in the user message. Choose every tile that matches it.
Rules:
- In a 3x3 grid every tile is a separate photo. Pick the tiles whose photo clearly contains the object.
- In a 4x4 grid one photo is cut into squares. Pick every square that contains any visible part of the object, including edges.
- A tile that already shows a blue overlay with a check mark is selected already; do not list it again.
- If nothing matches, return an empty list.
Think briefly in `reasoning`, then answer in `tiles`."""


class TileSelection(BaseModel):
    reasoning: str = Field(description="One or two sentences on what is visible in the matching tiles")
    tiles: list[int] = Field(description="Tile numbers to click, 1-based, row by row from the top-left")


async def human_pause(low: float = 0.25, high: float = 0.7) -> None:
    await asyncio.sleep(random.uniform(low, high))


async def click_center(page: Page, locator) -> None:
    box = await locator.bounding_box()
    if box is None:
        raise RuntimeError("the element to click is not visible")
    x = box["x"] + box["width"] * random.uniform(0.35, 0.65)
    y = box["y"] + box["height"] * random.uniform(0.35, 0.65)
    await page.mouse.move(x, y, steps=random.randint(6, 12))
    await page.mouse.click(x, y, delay=random.randint(60, 140))


async def anchor_checked(anchor: Frame) -> bool:
    try:
        return (await anchor.locator("#recaptcha-anchor").get_attribute("aria-checked")) == "true"
    except PlaywrightError:
        return False


async def challenge_open(page: Page) -> Frame | None:
    frame = frame_with(page, "/recaptcha/api2/bframe") or frame_with(page, "/recaptcha/enterprise/bframe")
    if frame is not None and await frame_visible(frame):
        return frame
    return None


async def grid_of(frame: Frame) -> tuple[int, int]:
    classes = (
        await frame.locator(
            "table.rc-imageselect-table-33, table.rc-imageselect-table-44, table.rc-imageselect-table-42"
        ).first.get_attribute("class")
        or ""
    )
    for suffix, shape in (("33", (3, 3)), ("44", (4, 4)), ("42", (4, 2))):
        if f"table-{suffix}" in classes:
            return shape
    tiles = await frame.locator("td.rc-imageselect-tile").count()
    return (4, 4) if tiles == 16 else (3, 3)


def has_blank_tile(raw: bytes, columns: int, rows: int) -> bool:
    gray = Image.open(io.BytesIO(raw)).convert("L")
    tile_w, tile_h = gray.width / columns, gray.height / rows
    for row in range(rows):
        for col in range(columns):
            box = (
                int(col * tile_w + tile_w * 0.1),
                int(row * tile_h + tile_h * 0.1),
                int((col + 1) * tile_w - tile_w * 0.1),
                int((row + 1) * tile_h - tile_h * 0.1),
            )
            stat = ImageStat.Stat(gray.crop(box))
            if stat.mean[0] > 240 and stat.stddev[0] < 8:
                return True
    return False


async def settled_screenshot(area, columns: int, rows: int) -> bytes:
    deadline = time.monotonic() + SETTLE_SECONDS
    previous: bytes | None = None
    while True:
        raw = await area.screenshot(type="png")
        if raw == previous and not has_blank_tile(raw, columns, rows):
            return raw
        if time.monotonic() >= deadline:
            return raw
        previous = raw
        await asyncio.sleep(0.8)


async def numbered_screenshot(frame: Frame, columns: int, rows: int) -> Path:
    area = frame.locator(".rc-imageselect-challenge")
    raw = await settled_screenshot(area, columns, rows)
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    image = image.resize((image.width * 2, image.height * 2), Image.Resampling.LANCZOS)
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=max(14, image.width // 24))
    except TypeError:
        font = ImageFont.load_default()
    tile_w, tile_h = image.width / columns, image.height / rows
    for row in range(rows):
        for col in range(columns):
            number = row * columns + col + 1
            left, top = col * tile_w + 4, row * tile_h + 4
            label = str(number)
            box = draw.textbbox((left, top), label, font=font)
            draw.rectangle((box[0] - 4, box[1] - 2, box[2] + 4, box[3] + 2), fill=(255, 255, 255), outline=(0, 0, 0))
            draw.text((left, top), label, fill=(0, 0, 0), font=font)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    path = WORK_DIR / f"grid-{int(time.time() * 1000)}.png"
    image.save(path)
    return path


async def instruction_text(frame: Frame) -> str:
    text = await frame.locator(".rc-imageselect-instructions").first.inner_text()
    return re.sub(r"\s+", " ", text).strip()


async def solve_challenge(page: Page, frame: Frame, provider: OpenAIProvider, deadline: float) -> str:
    verify = frame.locator("#recaptcha-verify-button")
    rounds = 0
    while rounds < MAX_DYNAMIC_ROUNDS and time.monotonic() < deadline:
        rounds += 1
        task = await instruction_text(frame)
        columns, rows = await grid_of(frame)
        dynamic = "once there are none left" in task.lower()
        image = await numbered_screenshot(frame, columns, rows)
        answer = await provider.generate_with_images(
            images=[image],
            response_schema=TileSelection,
            user_prompt=f"Task: {task}\nGrid: {columns} columns by {rows} rows ({columns * rows} tiles).",
            description=SYSTEM,
        )
        picks = sorted({n for n in answer.tiles if 1 <= n <= columns * rows})
        tiles = frame.locator("td.rc-imageselect-tile")
        for number in picks:
            await click_center(page, tiles.nth(number - 1))
            await human_pause()
        if dynamic and picks:
            await asyncio.sleep(1.5)
            continue
        await human_pause(0.6, 1.2)
        await click_center(page, verify)
        return "verified"
    await click_center(page, verify)
    return "verified"


async def blocked(frame: Frame | None) -> bool:
    if frame is None:
        return False
    try:
        return await frame.locator(".rc-doscaptcha-header-text").count() > 0
    except PlaywrightError:
        return False


async def solve(page: Page, budget_s: float) -> dict[str, object]:
    deadline = time.monotonic() + budget_s
    anchor = frame_with(page, "/recaptcha/api2/anchor") or frame_with(page, "/recaptcha/enterprise/anchor")
    if anchor is None:
        return {"outcome": "failed", "reason": "no reCAPTCHA checkbox frame on the page", "challenges": 0}
    if await anchor_checked(anchor):
        return {"outcome": "solved", "challenges": 0, "note": "the checkbox was already checked"}
    provider = OpenAIProvider()
    challenges = 0
    if await challenge_open(page) is None:
        await click_center(page, anchor.locator(".recaptcha-checkbox-border").first)
        for _ in range(16):
            await asyncio.sleep(0.5)
            if await anchor_checked(anchor):
                return {"outcome": "solved", "challenges": 0, "note": "the checkbox passed without images"}
            if await challenge_open(page) is not None:
                break
    while challenges < MAX_CHALLENGES and time.monotonic() < deadline:
        frame = await challenge_open(page)
        if frame is None:
            if await anchor_checked(anchor):
                return {"outcome": "solved", "challenges": challenges}
            await asyncio.sleep(1.0)
            if await challenge_open(page) is None:
                return {
                    "outcome": "solved" if await anchor_checked(anchor) else "failed",
                    "challenges": challenges,
                    "reason": "the challenge closed without a result",
                }
            continue
        if await blocked(frame):
            return {
                "outcome": "failed",
                "reason": "Google is refusing this browser right now (try again later)",
                "challenges": challenges,
            }
        challenges += 1
        await solve_challenge(page, frame, provider, deadline)
        for _ in range(14):
            await asyncio.sleep(0.5)
            if await anchor_checked(anchor):
                return {"outcome": "solved", "challenges": challenges}
    return {
        "outcome": "failed",
        "reason": f"not solved after {challenges} challenge(s) or the time budget",
        "challenges": challenges,
    }
