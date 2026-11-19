import asyncio

from hcaptcha_challenger import AgentConfig, AgentV
from hcaptcha_challenger.models import ChallengeSignal
from loguru import logger as solver_log
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page

from .frames import frame_visible, frame_with
from .model import FATAL, OpenAIProvider
from .workdir import work_dir

WORK_DIR = work_dir() / "hcaptcha"
HSW_FROM_PAGE = (
    "() => { const hit = performance.getEntriesByType('resource').map(e => e.name).find(n => /\\/hsw\\.js(\\?|$)/.test(n));"
    " return typeof hsw === 'function' ? null : (hit || null); }"
)


def solver_agent(page: Page, timeout_s: float) -> AgentV:
    config = AgentConfig(
        GEMINI_API_KEY="unused-the-openai-provider-answers",
        cache_dir=WORK_DIR / "cache",
        challenge_dir=WORK_DIR / "challenge",
        captcha_response_dir=WORK_DIR / "response",
        EXECUTION_TIMEOUT=timeout_s,
    )
    agent = AgentV(page=page, agent_config=config)
    provider = OpenAIProvider()
    arm = agent.robotic_arm
    for reasoner in (
        arm._challenge_router,
        arm._image_classifier,
        arm._spatial_path_reasoner,
        arm._spatial_point_reasoner,
    ):
        reasoner._provider = provider
    return agent


async def inject_hsw(page: Page) -> bool:
    for frame in page.frames:
        try:
            url = await frame.evaluate(HSW_FROM_PAGE)
        except PlaywrightError:
            continue
        if not url:
            continue
        response = await page.context.request.get(url)
        if response.ok:
            await page.evaluate(await response.text())
            return True
    return False


async def solve(page: Page, budget_s: float) -> dict[str, object]:
    solver_log.remove()
    outcomes: list[str] = []
    solver_log.add(
        lambda message: outcomes.append(message.record["message"][:140]),
        filter=lambda record: record["name"].startswith("hcaptcha_challenger"),
        level="DEBUG",
        format="{message}",
    )
    agent = solver_agent(page, budget_s)
    injected = await inject_hsw(page)
    checkbox = frame_with(page, "frame=checkbox")
    challenge = frame_with(page, "frame=challenge")
    challenge_open = challenge is not None and await frame_visible(challenge)
    if not challenge_open and checkbox is not None:
        await agent.robotic_arm.click_checkbox()
    task = asyncio.create_task(agent.wait_for_challenge())
    deadline = asyncio.get_running_loop().time() + budget_s
    signal = ChallengeSignal.EXECUTION_TIMEOUT
    while not task.done() and not FATAL["reason"] and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.5)
    if task.done():
        signal = task.result()
    else:
        task.cancel()
        if FATAL["reason"]:
            return {"outcome": "error", "reason": FATAL["reason"], "log": [line for line in outcomes[-4:]]}
    detail = [
        line for line in outcomes if line.startswith(("Start Challenge", "Failed to challenge", "Challenge success"))
    ]
    return {
        "outcome": "solved" if signal == ChallengeSignal.SUCCESS else "failed",
        "signal": signal.value if hasattr(signal, "value") else str(signal),
        "hsw_injected": injected,
        "log": detail[-6:],
    }
