import asyncio
import base64
import json
import mimetypes
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel

URL = "https://api.openai.com/v1/chat/completions"
CALL_TIMEOUT_S = 60.0
ATTEMPTS = 2
ResponseT = TypeVar("ResponseT", bound=BaseModel)


@dataclass
class Usage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0

    def add(self, payload: dict[str, Any], seconds: float) -> None:
        usage = payload.get("usage") or {}
        self.calls += 1
        self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
        self.completion_tokens += int(usage.get("completion_tokens") or 0)
        self.seconds += seconds

    def as_dict(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "model_seconds": round(self.seconds, 1),
        }


USAGE = Usage()
FATAL: dict[str, str | None] = {"reason": None}


class ModelFailure(RuntimeError):
    pass


def model_name() -> str:
    name = os.environ.get("FLEET_BROWSER_SOLVER_MODEL", "")
    if not name:
        raise RuntimeError("FLEET_BROWSER_SOLVER_MODEL is not set")
    return name


def api_key() -> str:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return key


class OpenAIProvider:
    def __init__(self) -> None:
        self._key = api_key()
        self._model = model_name()

    async def generate_with_images(
        self,
        *,
        images: list[Path],
        response_schema: type[ResponseT],
        user_prompt: str | None = None,
        description: str | None = None,
        **_: object,
    ) -> ResponseT:
        content: list[dict[str, Any]] = []
        for path in images:
            data = base64.b64encode(await asyncio.to_thread(Path(path).read_bytes)).decode()
            mime = mimetypes.guess_type(str(path))[0] or "image/png"
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
        if user_prompt:
            content.append({"type": "text", "text": user_prompt})
        schema = json.dumps(response_schema.model_json_schema())
        system = f"{description or ''}\n\nReturn ONLY a JSON object (no markdown) matching this JSON schema:\n{schema}"
        body = {
            "model": self._model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
        }
        for attempt in range(1, ATTEMPTS + 1):
            started = time.monotonic()
            try:
                async with httpx.AsyncClient(timeout=CALL_TIMEOUT_S) as client:
                    response = await client.post(URL, headers={"Authorization": f"Bearer {self._key}"}, json=body)
                response.raise_for_status()
                payload = response.json()
                match = re.search(r"\{[\s\S]*\}", payload["choices"][0]["message"]["content"] or "")
                if not match:
                    raise ValueError("no JSON object in the model reply")
                parsed = response_schema(**json.loads(match.group(0)))
            except httpx.HTTPStatusError as error:
                status = error.response.status_code
                if status in (401, 403) or (status == 429 and "insufficient_quota" in error.response.text):
                    FATAL["reason"] = f"the model API refused the request ({status}); check the solver key and quota"
                    raise ModelFailure(FATAL["reason"]) from error
                if attempt == ATTEMPTS:
                    raise
                continue
            except (httpx.HTTPError, ValueError, KeyError):
                if attempt == ATTEMPTS:
                    raise
                continue
            USAGE.add(payload, time.monotonic() - started)
            return parsed
        raise AssertionError("unreachable")

    def cache_response(self, path: Path) -> None:
        return None
