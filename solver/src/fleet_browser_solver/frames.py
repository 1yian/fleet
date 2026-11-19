import re
from dataclasses import dataclass
from typing import Literal

from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Frame, Page

Kind = Literal["hcaptcha", "recaptcha", "turnstile"]

PATTERNS: dict[Kind, re.Pattern[str]] = {
    "hcaptcha": re.compile(r"^https://[a-z0-9.-]*hcaptcha\.com/captcha/"),
    "recaptcha": re.compile(r"^https://www\.(google|recaptcha)\.(com|net)/recaptcha/(api2|enterprise)/(anchor|bframe)"),
    "turnstile": re.compile(r"^https://challenges\.cloudflare\.com/"),
}


@dataclass(frozen=True)
class Found:
    kind: Kind
    visible: bool
    url: str


async def frame_visible(frame: Frame) -> bool:
    try:
        element = await frame.frame_element()
        box = await element.bounding_box()
        if box is None or box["width"] < 20 or box["height"] < 20:
            return False
        return bool(
            await element.evaluate(
                "el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect();"
                " return s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0 && Number(s.opacity) > 0; }"
            )
        )
    except PlaywrightError:
        return False


async def detect(page: Page) -> list[Found]:
    found: list[Found] = []
    for frame in page.frames:
        for kind, pattern in PATTERNS.items():
            if pattern.match(frame.url):
                found.append(Found(kind, await frame_visible(frame), frame.url))
    return found


def frame_with(page: Page, needle: str) -> Frame | None:
    for frame in page.frames:
        if needle in frame.url:
            return frame
    return None
