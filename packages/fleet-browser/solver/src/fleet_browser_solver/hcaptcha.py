import asyncio
from pathlib import Path

from hcaptcha_challenger import AgentConfig, AgentV
from hcaptcha_challenger.models import ChallengeSignal, ImageAreaSelectChallenge, PointCoordinate
from loguru import logger as solver_log
from playwright.async_api import Error as PlaywrightError
from playwright.async_api import Page
from pydantic import BaseModel

from .frames import frame_visible, frame_with
from .model import FATAL, OpenAIProvider
from .workdir import work_dir

WORK_DIR = work_dir() / "hcaptcha"
HSW_FROM_PAGE = (
    "() => { const hit = performance.getEntriesByType('resource').map(e => e.name).find(n => /\\/hsw\\.js(\\?|$)/.test(n));"
    " return typeof hsw === 'function' ? null : (hit || null); }"
)


POINT_PROMPT = (
    "You solve a visual puzzle. The image shows a prompt bar on top and several cartoon objects on a patterned"
    " background. Click the object or objects that satisfy the prompt, using the extra task text when it is given."
    " Report the centre of each chosen object as permille of the whole image: x_permille 0 is the left edge and"
    " 1000 the right edge, y_permille 0 is the top edge and 1000 the bottom edge. Name each chosen object first."
)


class RelativePoint(BaseModel):
    object_description: str
    x_permille: int
    y_permille: int


class RelativePoints(BaseModel):
    challenge_prompt: str
    points: list[RelativePoint]


class RelativePointReasoner:
    def __init__(self, provider: OpenAIProvider, arm: object) -> None:
        self._provider = provider
        self._arm = arm
        self.view: dict[str, float] | None = None

    async def __call__(
        self,
        *,
        challenge_screenshot: Path,
        auxiliary_information: str | None = None,
        **_: object,
    ) -> ImageAreaSelectChallenge:
        view = self.view
        if view is None:
            raise RuntimeError("the challenge view was not measured before the model call")
        reply = await self._provider.generate_with_images(
            images=[challenge_screenshot],
            description=POINT_PROMPT,
            user_prompt=auxiliary_information,
            response_schema=RelativePoints,
        )
        points = [
            PointCoordinate(
                x=round(view["x"] + view["width"] * min(max(p.x_permille, 0), 1000) / 1000),
                y=round(view["y"] + view["height"] * min(max(p.y_permille, 0), 1000) / 1000),
            )
            for p in reply.points
        ]
        return ImageAreaSelectChallenge(challenge_prompt=reply.challenge_prompt, points=points)

    def cache_response(self, path: Path) -> None:
        return None


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
    for reasoner in (arm._challenge_router, arm._image_classifier, arm._spatial_path_reasoner):
        reasoner._provider = provider
    points = RelativePointReasoner(provider, arm)
    arm._spatial_point_reasoner = points
    capture = arm._capture_spatial_mapping

    async def capture_and_measure(frame_challenge, cache_key, crumb_id):
        shots = await capture(frame_challenge, cache_key, crumb_id)
        points.view = await frame_challenge.locator("//div[@class='challenge-view']").bounding_box()
        return shots

    arm._capture_spatial_mapping = capture_and_measure
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
