"""에이전트 공용 유틸: 상태 이벤트 콜백, 스킬·파라미터 파일 로딩."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent

# emit(agent_id, status, progress_note) — status: idle | working | done | failed
Emit = Callable[[str, str, str], None]


def noop_emit(agent_id: str, status: str, note: str = "") -> None:
    pass


@lru_cache(maxsize=None)
def read_skill(name: str) -> str:
    """skills/<name>.md 원문. 프롬프트에 그대로 삽입한다."""
    return (ROOT / "skills" / f"{name}.md").read_text(encoding="utf-8")


@lru_cache(maxsize=1)
def load_params() -> dict:
    return json.loads((ROOT / "data" / "industry_params.json").read_text(encoding="utf-8"))
