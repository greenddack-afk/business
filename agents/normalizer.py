"""Normalizer: 한 줄 아이디어 → 구조화 JSON + 업종코드 + 검색어 6~9개."""
from __future__ import annotations

import re
from typing import Optional

import schema
from llm import FAST_MODEL, call_llm

from . import Emit, load_params, noop_emit

AGENT_ID = "normalizer"

EXAMPLE_IDEAS = ["따뜻한 폼롤러", "반려견 수제간식 정기배송", "동네 소상공인용 예약 관리 앱"]

_JAMO_ONLY = re.compile(r"^[ㄱ-ㅎㅏ-ㅣ\s\W\d_]+$")
_MEANINGFUL = re.compile(r"[가-힣]{2,}|[A-Za-z]{2,}")


def validate_idea(text: Optional[str]) -> tuple[bool, str]:
    """LLM 호출 전 입력 검증. (통과 여부, 사유). 프론트 검증과 동일 규칙."""
    t = (text or "").strip()
    if not t:
        return False, "아이디어를 입력해 주세요."
    if len(t) < 2:
        return False, "너무 짧습니다. 제품이나 서비스가 드러나게 적어 주세요."
    if len(t) > 100:
        return False, "100자 이내 한 줄로 적어 주세요."
    if _JAMO_ONLY.match(t) or not _MEANINGFUL.search(t):
        return False, "사업 아이템으로 해석할 수 없는 입력입니다."
    if len(set(t.replace(" ", ""))) <= 2 and len(t) >= 4:
        return False, "같은 글자가 반복된 입력입니다."
    return True, ""


def _dedupe_queries(queries: list[str]) -> list[str]:
    seen: set[str] = set()
    out = []
    for q in queries:
        key = re.sub(r"[\s\W_]+", "", q).lower()
        if key and key not in seen:
            seen.add(key)
            out.append(q.strip())
    return out


def _system_prompt() -> str:
    params = load_params()["industries"]
    lines = []
    for code, ind in params.items():
        tag = "정교화" if ind.get("refined") else "범용"
        lines.append(f'- "{code}": {ind["label"]} ({tag})')
    industries = "\n".join(lines)
    return f"""너는 투자 심사역 팀의 아이디어 정규화 담당이다. 사용자가 던진 한 줄 사업 아이디어를 구조화한다.
질문을 되묻지 않는다. 정보가 부족하면 가정으로 채우고, 가정은 assumptions에 명시한다.

[출력 필드]
- product: 제품·서비스가 무엇인지 한 문장 (하드웨어/소프트웨어/서비스 구분 포함)
- target: 핵심 고객 한 문장 (연령·상황·문제)
- differentiator: 기존 대안 대비 차별점 한 문장
- industry_code: 아래 8개 중 정확히 하나
{industries}
- industry_confidence: 0~1 (분류 확신도)
- interpretation: industry_code가 "manufacturing"이면 "oem_import"(해외 OEM 수입·자체 브랜드, 기본) 또는 "own_manufacturing"(국내 자체 제조). 입력이 자체 제조를 분명히 시사할 때만 own_manufacturing. 그 외 업종은 "default".
  해석이 갈리면 **자본이 적게 드는 해석을 기본값**으로 고른다.
- alternative_interpretation: 다른 해석과 그 영향을 한 줄로. (예: "자체 제조로 볼 경우 금형 포함 초기투자 약 3배")
- assumptions: 3~5개. 각 {{key, value, reason}}. 반드시 포함: 초기 자본 규모, 판매 채널·지역, 제조/운영 방식. value는 구체적 숫자·범위로.
  초기 자본의 기본 가정은 **예비창업자·소자본 창업 기준 3,000만원(1인~소규모 팀)**이다. 입력이 대규모 자본을 분명히 시사할 때만 올린다. 자체 제조 해석은 alternative_interpretation에서만 다룬다.
  제품 가격·수량 같은 시장 수치는 검색 근거가 없으므로 assumptions에 만들어 넣지 마라(뒷단 에이전트가 검색으로 정한다).
- queries: 웹 검색어 6~9개. 서로 겹치지 않게, 한국어, 각 40자 이내. 다음 관점을 모두 덮는다:
  시장 규모·성장률 / 경쟁 제품·가격대 / 소비자 트렌드 / 인증·규제 / 원가·제조 또는 운영비 / 채널 수수료·광고비 / 소비자 후기·불만 / 유사 사례·실패 사례

[입력이 모호하거나 추상적일 때]
분석을 거부하지 않는다. 가장 근접한 해석 하나를 골라 진행하고, 나머지 해석은 alternative_interpretation에 적는다.

[톤] 투자 심사역. 응원·감탄 표현 금지.
[출력 형식] JSON 객체 하나만. 마크다운 백틱, 설명문 금지."""


def run(idea: str, emit: Emit = noop_emit) -> schema.AgentResult:
    emit(AGENT_ID, "working", "아이디어 해석·업종 분류 중")
    system = _system_prompt()

    def call(feedback: Optional[str]) -> str:
        user = f"아이디어: {idea}"
        if feedback:
            user += "\n\n" + feedback
        return call_llm(system, user, model=FAST_MODEL, max_tokens=2000)["text"]

    result = schema.run_with_retry(AGENT_ID, call)
    if result.ok:
        result.data["queries"] = _dedupe_queries(result.data["queries"])
        code = result.data["industry_code"]
        emit(AGENT_ID, "done", f"업종: {load_params()['industries'][code]['label']}")
    else:
        emit(AGENT_ID, "failed", "아이디어 해석 실패")
    return result
