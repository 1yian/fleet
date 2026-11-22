import asyncio
import time

from playwright.async_api import Page

from .frames import frame_visible
from .recaptcha import human_pause

TOKEN_SCRIPT = '() => [...document.querySelectorAll(\'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]\')].some(e => e.value && e.value.length > 10)'
INTERSTITIAL_TITLES = ("just a moment", "attention required", "checking your browser")


async def token_present(page: Page) -> bool:
    return bool(await page.evaluate(TOKEN_SCRIPT))


async def interstitial_cleared(page: Page) -> bool:
    return not (await page.title()).strip().lower().startswith(INTERSTITIAL_TITLES)


async def solve(page: Page, budget_s: float) -> dict[str, object]:
    deadline = time.monotonic() + budget_s
    frames = [f for f in page.frames if f.url.startswith("https://challenges.cloudflare.com/") and f.parent_frame]
    visible = [f for f in frames if await frame_visible(f)]
    if not visible:
        return {"outcome": "failed", "reason": "no visible Cloudflare widget"}
    element = await visible[0].frame_element()
    box = await element.bounding_box()
    if box is None:
        return {"outcome": "failed", "reason": "the Cloudflare widget has no size"}
    await asyncio.sleep(3.0)
    if await token_present(page):
        return {"outcome": "solved", "note": "the widget passed by itself"}
    x = box["x"] + min(34.0, box["width"] * 0.12)
    y = box["y"] + box["height"] / 2
    await page.mouse.move(x - 120, y + 30, steps=8)
    await human_pause()
    await page.mouse.move(x, y, steps=12)
    await page.mouse.click(x, y, delay=90)
    while time.monotonic() < deadline:
        await asyncio.sleep(0.7)
        if await token_present(page):
            return {"outcome": "solved"}
        if await interstitial_cleared(page) and not any(
            f.url.startswith("https://challenges.cloudflare.com/") for f in page.frames
        ):
            return {"outcome": "solved", "note": "the check page went away"}
    return {"outcome": "failed", "reason": "the Cloudflare check did not pass"}
