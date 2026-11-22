import asyncio
import json
import sys
import time

import httpx
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page, async_playwright

from . import hcaptcha, recaptcha, turnstile
from .frames import detect
from .model import USAGE


async def pick_page(browser, target_id: str) -> Page:
    for context in browser.contexts:
        for page in context.pages:
            session = await context.new_cdp_session(page)
            try:
                info = await session.send("Target.getTargetInfo")
            finally:
                await session.detach()
            if info["targetInfo"]["targetId"] == target_id:
                return page
    raise RuntimeError("the lane's active tab was not found")


def option(name: str, default: str) -> str:
    args = sys.argv
    return args[args.index(name) + 1] if name in args else default


async def run() -> dict[str, object]:
    command = sys.argv[1]
    cdp = option("--cdp", "")
    target = option("--target", "")
    kind = option("--kind", "auto")
    budget = float(option("--budget", "150"))
    started = time.monotonic()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp)
        try:
            page = await pick_page(browser, target)
            found = await detect(page)
            summary = [{"kind": f.kind, "visible": f.visible} for f in found]
            if command == "detect":
                return {"captchas": summary}
            wanted = [f for f in found if f.visible and f.kind in ("hcaptcha", "recaptcha", "turnstile")]
            if kind != "auto":
                wanted = [f for f in wanted if f.kind == kind]
            if not wanted:
                return {"outcome": "none", "captchas": summary}
            chosen = wanted[0].kind
            solvers = {"hcaptcha": hcaptcha.solve, "recaptcha": recaptcha.solve, "turnstile": turnstile.solve}
            result = await solvers[chosen](page, budget)
            return {"kind": chosen, **result, "seconds": round(time.monotonic() - started, 1), "model": USAGE.as_dict()}
        finally:
            await browser.close()


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("solve", "detect"):
        print(
            json.dumps({"outcome": "error", "reason": "usage: fleet-browser-solver solve|detect --cdp URL --target ID"})
        )
        sys.exit(2)
    try:
        result = asyncio.run(run())
    except (RuntimeError, ValueError, KeyError, OSError, httpx.HTTPError, PlaywrightError) as error:
        result = {"outcome": "error", "reason": f"{type(error).__name__}: {str(error)[:300]}", "model": USAGE.as_dict()}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
