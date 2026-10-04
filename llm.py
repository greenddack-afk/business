"""Claude 호출 공용 래퍼: temperature 0.2 고정, 동일 입력 해시 캐싱, 토큰 사용량 집계.

에이전트·검색 풀이 모두 이 함수만 거친다. (Anthropic 키 1개로 웹 검색까지 처리한다.)
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any, Optional

import anthropic
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=True)

CACHE_DIR = ROOT / ".cache" / "llm"
FAST_MODEL = os.getenv("FAST_MODEL", "claude-haiku-4-5-20251001")  # 정규화·검색 수집
SMART_MODEL = os.getenv("SMART_MODEL", "claude-sonnet-5")  # 시장·재무·실행 분석
# 비평·종합은 순차 구간이라 전체 소요 시간을 좌우한다. .env에서 바꿀 수 있다.
# 비평은 형식이 고정된 작업이라 빠른 모델로도 근거 있는 반론이 나온다(약 17초 vs 45초).
# 최종 판정문은 한 줄 카피의 밀도가 중요해 좋은 모델을 쓴다.
CRITIC_MODEL = os.getenv("CRITIC_MODEL", FAST_MODEL)
SYNTH_MODEL = os.getenv("SYNTH_MODEL", SMART_MODEL)
TEMPERATURE = 0.2

WEB_SEARCH_TOOL = {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 1,
    "user_location": {"type": "approximate", "country": "KR", "timezone": "Asia/Seoul"},
}

class TruncatedResponse(RuntimeError):
    """max_tokens에 걸려 응답이 중간에 끊긴 경우."""


_client: Optional[anthropic.Anthropic] = None
_lock = threading.Lock()
# temperature를 받지 않는 모델(예: Sonnet 5는 deprecated). 모델별로 기억한다.
# 전역 플래그로 두면 병렬 호출에서 경쟁 상태가 생겨 다른 스레드가 헛되이 실패한다.
_no_temperature: set[str] = set()
USAGE = {"input_tokens": 0, "output_tokens": 0, "calls": 0, "cache_hits": 0}


def client() -> anthropic.Anthropic:
    global _client
    with _lock:
        if _client is None:
            key = os.getenv("ANTHROPIC_API_KEY", "").strip()
            if not key:
                raise RuntimeError("ANTHROPIC_API_KEY가 .env에 없습니다.")
            _client = anthropic.Anthropic(api_key=key, max_retries=2)
        return _client


def _cache_key(model: str, system: str, user: str, temperature: float, tools: Optional[list]) -> str:
    raw = json.dumps([model, system, user, temperature, tools], ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _text_of(content: list[dict]) -> str:
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")


def call_llm(
    system: str,
    user: str,
    *,
    model: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = TEMPERATURE,
    tools: Optional[list] = None,
    use_cache: bool = True,
    timeout: float = 90.0,
    thinking: Optional[dict] = None,
) -> dict[str, Any]:
    """{"text": str, "content": [block dict...], "cached": bool} 를 반환한다."""
    model = model or SMART_MODEL
    use_cache = use_cache and os.getenv("NO_CACHE") != "1"
    key = _cache_key(model, system, user, temperature, tools)
    path = CACHE_DIR / f"{key}.json"
    if use_cache and path.exists():
        try:
            content = json.loads(path.read_text(encoding="utf-8"))
            USAGE["cache_hits"] += 1
            return {"text": _text_of(content), "content": content, "cached": True}
        except (OSError, json.JSONDecodeError):
            pass

    kwargs: dict[str, Any] = dict(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
        timeout=timeout,
    )
    if tools:
        kwargs["tools"] = tools
    # Sonnet 5는 기본으로 '생각(thinking)'을 켠다. 정해진 JSON을 채우는 이 작업에서는 생각이 max_tokens를 전부 먹어
    # 본문이 0글자로 잘리고(재무 에이전트 실측: 14,000토큰 소진), 시간·비용만 늘린다. 기본은 끄고 필요할 때만 켠다.
    kwargs["thinking"] = thinking or {"type": "disabled"}
    if model not in _no_temperature:
        kwargs["extra_body"] = {"temperature": temperature}
    try:
        resp = client().messages.create(**kwargs)
    except anthropic.BadRequestError as exc:
        if "temperature" not in str(exc).lower():
            raise
        with _lock:
            _no_temperature.add(model)  # 이 모델은 이후 temperature 없이 호출한다
        kwargs.pop("extra_body", None)
        resp = client().messages.create(**kwargs)

    content = [b.model_dump() for b in resp.content]
    USAGE["calls"] += 1
    USAGE["input_tokens"] += getattr(resp.usage, "input_tokens", 0) or 0
    USAGE["output_tokens"] += getattr(resp.usage, "output_tokens", 0) or 0
    if resp.stop_reason == "max_tokens":
        # 잘린 JSON은 파싱 단계에서 모호한 오류로 번지므로 여기서 분명히 실패시키고 캐시하지 않는다.
        kinds = ",".join(b.get("type", "?") for b in content)
        raise TruncatedResponse(f"max_tokens({max_tokens}) 초과로 응답이 잘렸습니다(블록: {kinds}). 상한을 올리거나 출력을 줄이세요.")
    if use_cache:
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(content, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return {"text": _text_of(content), "content": content, "cached": False}
