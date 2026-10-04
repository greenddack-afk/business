"""Execution: 기술·자금·인력·규제 리스크 + 실행/리스크 점수."""
from __future__ import annotations

import schema
from search_pool import SearchPool

from . import Emit, noop_emit
from .base import COMMON_RULES, context_header, rubric_block, run_agent

AGENT_ID = "execution"

_BLOCK = '{"level": "상|중|하", "summary": "결론 문장", "detail": "근거 1~2문장", "lead_time_weeks": {"value": 숫자, "unit": "주", "source_url": "", "confidence": "estimated"}}'
_TEMPLATE = f"""{{
  "scores": {{
    "execution": {{"rubric_ref": "execution:5-6", "score": 5, "rationale": "결론 문장 + 근거"}},
    "risk":      {{"rubric_ref": "risk:3-4", "score": 4, "rationale": "..."}}
  }},
  "summary": "결론 문장으로 시작하는 실행가능성 요약 2문장",
  "tech": {_BLOCK},
  "capital": {_BLOCK},
  "people": {_BLOCK},
  "regulation": {_BLOCK}
}}"""


def _system() -> str:
    return f"""너는 투자 심사역 팀의 실행가능성 분석 담당(Execution)이다. 창업자 1~3명이 이 아이디어를 실제로 해낼 수 있는지, 그리고 어떤 리스크가 있는지 분석하고 실행·리스크 2개 축을 채점한다.

{COMMON_RULES}

[담당 규칙]
- tech / capital / people / regulation 4개 항목 각각 level을 "상|중|하"로 판정한다. 상 = 부담·위험이 크다.
- lead_time_weeks는 소요 기간이 있는 항목(인증·제조·개발 등)에만 넣고, 없으면 그 필드를 생략한다. 특히 regulation에 인증·허가 소요 기간이 검색으로 확인되면 반드시 넣는다.
- 자금(capital)은 정규화 가정의 초기 자본(assumptions)과 비교해 판단한다.
- 규제는 검색으로 확인된 인증·허가만 쓴다. 확인되지 않은 규제는 "확인 필요"라고 명시하고 level은 보수적으로(상) 둔다.
- 리스크 축은 안전할수록 높은 점수다(루브릭 참조). 안전사고·법적 책임·재고·단일 공급처 의존을 본다.

{rubric_block()}

[출력 스키마 — 이 구조 그대로]
{_TEMPLATE}"""


def run(norm: dict, pool: SearchPool, emit: Emit = noop_emit, force_fail: bool = False) -> schema.AgentResult:
    user = context_header(norm) + "\n\n" + pool.to_prompt_block()
    result = run_agent(
        AGENT_ID, _system(), user, emit,
        allowed_urls=pool.allowed_urls, start_note="기술·자금·인력·규제 점검 중", force_fail=force_fail,
    )
    if result.ok:
        lead = result.data["regulation"].get("lead_time_weeks")
        note = f"인증·규제 약 {lead['value']:g}주 소요" if lead else result.data["summary"][:30]
        emit(AGENT_ID, "done", note)
    return result
