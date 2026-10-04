"""Synthesizer: 1차 종합(점수·등급, 코드 고정) + (4단계) 비평 반영 최종 리포트.

등급 산식은 skills/viability_rubric.md의 '종합 등급 산식'과 동일하며 LLM이 정하지 않는다.
"""
from __future__ import annotations

import json
from typing import Optional

import schema
from llm import SYNTH_MODEL
from search_pool import SearchPool

from . import Emit, noop_emit
from .base import COMMON_RULES, context_header, run_agent

AGENT_ID = "synthesizer"

WEIGHTS = {"market": 0.25, "competition": 0.15, "execution": 0.20, "profitability": 0.25, "risk": 0.15}

# (하한, 등급, 판정)
GRADE_TABLE = [
    (8.5, "A+", "진행"),
    (8.0, "A", "진행"),
    (7.5, "A-", "진행"),
    (7.0, "B+", "조건부 진행"),
    (6.5, "B", "조건부 진행"),
    (6.0, "B-", "조건부 진행"),
    (5.5, "C+", "소규모 검증 후 재판단"),
    (5.0, "C", "소규모 검증 후 재판단"),
    (4.5, "C-", "보류"),
]


def weighted_average(scores: dict[str, Optional[int]]) -> tuple[Optional[float], bool]:
    """(가중 평균, 부분 평가 여부). 점수 없는 축은 빼고 남은 가중치로 다시 나눈다."""
    present = {a: s for a, s in scores.items() if s is not None}
    if not present:
        return None, True
    total_w = sum(WEIGHTS[a] for a in present)
    avg = sum(WEIGHTS[a] * s for a, s in present.items()) / total_w
    return round(avg, 2), len(present) < len(WEIGHTS)


def grade_for(avg: Optional[float]) -> tuple[str, str]:
    if avg is None:
        return "-", "평가 불가"
    for floor, grade, decision in GRADE_TABLE:
        if avg >= floor:
            return grade, decision
    return "D", "비권장"


def collect_scores(market: Optional[dict], finance: Optional[dict], execution: Optional[dict]) -> dict[str, Optional[dict]]:
    """에이전트 결과(실패 시 None)에서 5축 점수 객체를 모은다. 실패한 축은 None."""
    out: dict[str, Optional[dict]] = {a: None for a in schema.AXES}
    for data, axes in ((market, ("market", "competition")), (finance, ("profitability",)), (execution, ("execution", "risk"))):
        if data:
            for a in axes:
                out[a] = data["scores"][a]
    return out


def draft(market: Optional[dict], finance: Optional[dict], execution: Optional[dict]) -> dict:
    """1차 종합: 5축 점수 + 초안 등급. Critic이 이 결과를 공격한다."""
    scores = collect_scores(market, finance, execution)
    avg, partial = weighted_average({a: (s["score"] if s else None) for a, s in scores.items()})
    grade, decision = grade_for(avg)
    return {"scores": scores, "weighted_average": avg, "grade": grade, "decision": decision, "partial": partial}


# ---------------------------------------------------------------- 최종 종합
_TEMPLATE = """{
  "one_liner": "이 아이디어에 대한 한 줄 판정. 등급을 설명하는 문장이 아니라 '무엇이 핵심 변수인가'를 짚는 문장. 40자 내외",
  "assumptions": [{"key": "초기 자본", "value": "3,000만원", "reason": "왜 이렇게 가정했는지"}],
  "roadmap": [
    {"stage": "1단계 검증", "period": "0~4주", "actions": ["구체적 행동 2~4개"],
     "cost": {"value": 숫자, "unit": "만원", "source_url": "", "confidence": "estimated"},
     "gate_condition": "이 조건을 만족해야 다음 단계로 간다 (숫자 포함)"},
    {"stage": "2단계 최소판매", "period": "1~3개월", "actions": ["..."], "cost": {...}, "gate_condition": "..."},
    {"stage": "3단계 확장", "period": "3~12개월", "actions": ["..."], "cost": {...}, "gate_condition": "..."}
  ]
}"""


def _system(grade: str, decision: str, degraded: list[str]) -> str:
    degraded_note = (
        f"\n- 다음 섹션은 분석에 실패해 데이터가 없다: {degraded}. 없는 데이터를 지어내지 말고, 그 영역을 검증하는 행동을 로드맵 1단계에 넣어라."
        if degraded else ""
    )
    return f"""너는 투자 심사역 팀의 최종 종합 담당(Synthesizer)이다. 동료 분석과 비평가 반론을 받아 최종 판정문·가정·3단계 로드맵을 쓴다.

{COMMON_RULES}

[담당 규칙]
- 등급({grade})과 판정({decision})은 이미 코드가 계산했다. 바꾸려 하지 말고, one_liner가 그 등급과 모순되지 않게 쓴다.
- one_liner는 응원도 위로도 아니다. 이 사업의 성패를 가르는 단일 변수를 짚는다. (예: "시장은 있으나 차별점을 제품이 아닌 유통에서 만들어야 한다")
- assumptions는 정규화 단계의 가정에 재무 분석에서 실제로 쓴 숫자(판매가·초기자본·채널)를 반영해 3~5개로 정리한다. 리포트 최상단에 그대로 노출되므로 사용자가 "나는 이것과 다른데"라고 판단할 수 있을 만큼 구체적이어야 한다.
- roadmap은 정확히 3단계다: 검증(0~4주) → 최소판매(1~3개월) → 확장(3~12개월).
  각 단계의 actions는 이 아이디어에만 해당하는 구체적 행동이다. "시장 조사하기" 같은 일반론 금지.
  gate_condition은 다음 단계로 넘어갈 수 있는 **측정 가능한 조건**이다(숫자 포함).
  cost는 그 단계에서 쓰는 비용이며 단위는 "만원"이다.
- 비평가 반론에서 제기된 리스크는 로드맵 1~2단계에서 검증되도록 배치한다.{degraded_note}

[출력 스키마 — 이 구조 그대로]
{_TEMPLATE}"""


def finalize(
    idea: str,
    norm: dict,
    pool: SearchPool,
    sections: dict,
    final_scores: dict,
    applied: list[dict],
    critique: Optional[dict],
    degraded: list[str],
    emit: Emit = noop_emit,
    force_fail: bool = False,
) -> tuple[dict, schema.AgentResult]:
    """최종 리포트 JSON을 만든다. LLM 실패 시에도 로드맵만 비운 리포트를 돌려준다(전체 중단 금지)."""
    avg, partial = weighted_average({a: (s["score"] if s else None) for a, s in final_scores.items()})
    grade, decision = grade_for(avg)

    context = {
        "최종 5축 점수(비평 반영 후)": {a: (s["score"] if s else "데이터 부족") for a, s in final_scores.items()},
        "반영된 조정": applied,
        "비평가 반론": critique["objections"] if critique else "비평 실패",
        "시장 분석": sections.get("market"),
        "재무 분석": sections.get("finance"),
        "실행 분석": sections.get("execution"),
    }
    user = (
        context_header(norm)
        + f"\n\n[코드가 계산한 최종 등급] {grade} · {decision} (가중평균 {avg})\n\n[동료 분석 종합]\n"
        + json.dumps(context, ensure_ascii=False, indent=2, default=str)
        + "\n\n"
        + pool.to_prompt_block(max_results=20)
    )
    # 내부 스키마 이름은 synthesizer_llm이지만, 화면 상태 카드는 6종 고정이므로 synthesizer로 방출한다.
    def emit_as_synth(_agent_id: str, status: str, note: str = "") -> None:
        emit(AGENT_ID, status, note)

    result = run_agent(
        "synthesizer_llm", _system(grade, decision, degraded), user, emit_as_synth,
        allowed_urls=pool.allowed_urls, start_note="최종 판정·로드맵 작성 중", force_fail=force_fail,
        max_tokens=2600, model=SYNTH_MODEL,
    )
    written = result.data if result.ok else {}

    report = {
        "idea_raw": idea,
        "normalized": {k: norm[k] for k in (
            "product", "target", "differentiator", "industry_code",
            "industry_confidence", "interpretation", "alternative_interpretation")},
        "verdict": {
            "grade": grade if grade != "-" else "D",
            "decision": decision + (" (부분 평가)" if partial else ""),
            "one_liner": written.get("one_liner") or "핵심 변수를 특정하지 못했다. 아래 축별 점수와 반론을 직접 대조해 판단하라.",
        },
        "assumptions": written.get("assumptions") or norm.get("assumptions", []),
        "scores": final_scores,
        "market": sections.get("market"),
        "roi": sections.get("finance"),
        "feasibility": sections.get("execution"),
        "critique": critique,
        "roadmap": written.get("roadmap") or [],
        "sources": _build_sources(pool, {**sections, "critic": critique}),
        "degraded_sections": list(degraded),
        "meta": {
            "weighted_average": avg,
            "partial": partial,
            "applied_adjustments": applied,
            "queries_run": pool.queries_run,
        },
    }
    if not report["roadmap"]:
        report["degraded_sections"].append("roadmap")
    report = schema.normalize_numbers(report, pool.allowed_urls)
    emit(AGENT_ID, "done" if result.ok else "failed", f"최종 등급 {report['verdict']['grade']}")
    return report, result


def _build_sources(pool: SearchPool, sections: dict) -> list[dict]:
    """리포트에서 실제로 인용된 URL만 출처 목록에 올린다."""
    used: dict[str, set[str]] = {}
    for name, data in sections.items():
        for url in _walk_urls(data):
            label = {"market": "시장", "finance": "ROI", "execution": "실행가능성", "critic": "비평"}.get(name, name)
            used.setdefault(url, set()).add(label)
    out = []
    for r in pool.as_list():
        tags = used.get(r["url"])
        if tags:
            out.append({"title": r["title"], "url": r["url"], "used_for": " · ".join(sorted(tags))})
    return out


def _walk_urls(node) -> list[str]:
    if isinstance(node, dict):
        urls = []
        for k, v in node.items():
            if k in ("source_url", "url", "evidence_url") and isinstance(v, str) and v.strip():
                urls.append(v.strip())
            else:
                urls.extend(_walk_urls(v))
        return urls
    if isinstance(node, list):
        return [u for x in node for u in _walk_urls(x)]
    return []
