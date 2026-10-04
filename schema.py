"""리포트 JSON 스키마 + 검증·재시도 로직.

- 에이전트 6종의 출력 스키마를 한곳에서 정의한다.
- 모든 숫자는 {value, unit, source_url, confidence} 형태이며,
  source_url이 비었거나 검색 풀에 없는 URL이면 confidence를 "estimated"로 강제한다.
- run_with_retry: 검증 실패 시 1회 재시도, 2회 실패하면 ok=False로 돌려준다.
  호출자(pipeline.py)는 이 경우 해당 섹션만 비우고 degraded_sections에 추가한 뒤 계속 진행한다.
"""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

from jsonschema import Draft202012Validator

AGENT_IDS = ("normalizer", "market", "finance", "execution", "critic", "synthesizer")
AXES = ("market", "competition", "execution", "profitability", "risk")
AXIS_LABELS = {
    "market": "시장성",
    "competition": "경쟁",
    "execution": "실행",
    "profitability": "수익성",
    "risk": "리스크",
}
INDUSTRY_CODES = (
    "manufacturing",
    "commerce",
    "saas_software",
    "offline_store",
    "service_agency",
    "content_media",
    "platform_marketplace",
    "education_coaching",
)
INTERPRETATIONS = ("default", "oem_import", "own_manufacturing")
GRADES = ("A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D")
LEVELS = ("상", "중", "하")
OBJECTION_ANGLES = ("이미 존재한다", "숨은 비용", "고객이 돈을 안 낸다")
# 보고서에서 통째로 비워질 수 있는 섹션(= degraded_sections에 들어갈 수 있는 이름)
DEGRADABLE_SECTIONS = ("market", "roi", "feasibility", "critique", "roadmap")

_STR = {"type": "string", "minLength": 1}


def _ref(name: str) -> dict:
    return {"$ref": f"#/$defs/{name}"}


def _obj(props: dict, optional: Iterable[str] = ()) -> dict:
    optional = set(optional)
    return {
        "type": "object",
        "properties": props,
        "required": [k for k in props if k not in optional],
    }


def _nullable(schema: dict) -> dict:
    return {"anyOf": [schema, {"type": "null"}]}


NUMBER = {
    "type": "object",
    "properties": {
        "value": {"type": "number"},
        "unit": _STR,
        "source_url": {"type": "string"},
        "confidence": {"enum": ["sourced", "estimated"]},
    },
    "required": ["value", "unit", "source_url", "confidence"],
}

SCORE = _obj(
    {
        "score": {"type": "integer", "minimum": 0, "maximum": 10},  # 점수를 먼저 확정
        "rubric_ref": _STR,  # 예: "market:7-8"
        "rationale": _STR,  # 설명은 점수 뒤에
    }
)

SCORE_ADJUSTED = copy.deepcopy(SCORE)
SCORE_ADJUSTED["properties"]["adjusted_from"] = {"type": ["integer", "null"], "minimum": 0, "maximum": 10}
SCORE_ADJUSTED["required"].append("adjusted_from")

ASSUMPTION = _obj({"key": _STR, "value": _STR, "reason": _STR})

DEFS = {
    "number": NUMBER,
    "score": SCORE,
    "score_adjusted": SCORE_ADJUSTED,
    "assumption": ASSUMPTION,
}

# ---------------------------------------------------------------- 에이전트별 본문 스키마
NORMALIZER_PROPS = {
    "product": _STR,
    "target": _STR,
    "differentiator": _STR,
    "industry_code": {"enum": list(INDUSTRY_CODES)},
    "industry_confidence": {"type": "number", "minimum": 0, "maximum": 1},
    "interpretation": {"enum": list(INTERPRETATIONS)},
    "alternative_interpretation": _STR,
    "assumptions": {"type": "array", "minItems": 3, "items": _ref("assumption")},
    "queries": {"type": "array", "minItems": 6, "maxItems": 9, "items": {"type": "string", "minLength": 2}},
}

MARKET_BODY = {
    "summary": _STR,
    "size": _ref("number"),
    "growth": _ref("number"),
    "competition_level": {"enum": list(LEVELS)},  # 상 = 경쟁 강함
    "competitors": {
        "type": "array",
        "maxItems": 6,
        "items": _obj({"name": _STR, "positioning": _STR, "url": {"type": "string"}, "note": {"type": "string"}}),
    },
    "trends": {"type": "array", "minItems": 3, "maxItems": 3, "items": _STR},
}

_LEVEL_BLOCK = _obj(
    {
        "level": {"enum": list(LEVELS)},  # 상 = 부담·위험 큼
        "summary": _STR,
        "detail": {"type": "string"},
        "lead_time_weeks": _ref("number"),
    },
    optional=("lead_time_weeks",),
)

EXECUTION_BODY = {
    "summary": _STR,
    "tech": _LEVEL_BLOCK,
    "capital": _LEVEL_BLOCK,
    "people": _LEVEL_BLOCK,
    "regulation": _LEVEL_BLOCK,
}

_SCENARIO = _obj({"monthly_units": _ref("number"), "cumulative_profit_12m": _ref("number"), "note": {"type": "string"}})

FINANCE_BODY = {
    "summary": _STR,
    "initial_investment": {
        "type": "array",
        "minItems": 1,
        "items": _obj({"item": _STR, "amount": _ref("number")}),
    },
    "total_initial_investment": _ref("number"),
    "fixed_cost_monthly": _ref("number"),
    "unit_economics": _obj(
        {
            "price": _ref("number"),
            "unit_cost": _ref("number"),
            "variable_cost": _ref("number"),
            "contribution_margin": _ref("number"),
        }
    ),
    "break_even": _obj({"units_per_month": _ref("number"), "payback_months": _ref("number")}),
    "scenarios": _obj({"conservative": _SCENARIO, "base": _SCENARIO, "optimistic": _SCENARIO}),
}


def _agent_schema(body: dict, score_axes: tuple[str, ...]) -> dict:
    props = {"scores": _obj({a: _ref("score") for a in score_axes})}
    props.update(body)
    schema = _obj(props)
    schema["$defs"] = DEFS
    return schema


NORMALIZER_SCHEMA = _obj(NORMALIZER_PROPS)
NORMALIZER_SCHEMA["$defs"] = DEFS

CRITIC_SCHEMA = _obj(
    {
        "objections": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": _obj(
                {
                    "angle": {"enum": list(OBJECTION_ANGLES)},
                    "claim": _STR,
                    "evidence": _STR,
                    "evidence_url": {"type": "string"},
                }
            ),
        },
        "adjustments": {
            "type": "array",
            "maxItems": len(AXES),
            "items": _obj(
                {
                    "axis": {"enum": list(AXES)},
                    "delta": {"type": "integer", "minimum": -2, "maximum": 0},
                    "reason": _STR,
                    "evidence_url": {"type": "string"},
                }
            ),
        },
    }
)
CRITIC_SCHEMA["$defs"] = DEFS

_ROADMAP_STAGE = _obj(
    {
        "stage": _STR,
        "period": _STR,
        "actions": {"type": "array", "minItems": 1, "items": _STR},
        "cost": _ref("number"),
        "gate_condition": _STR,
    }
)

REPORT_SCHEMA = _obj(
    {
        "idea_raw": _STR,
        "normalized": _obj(
            {
                "product": _STR,
                "target": _STR,
                "differentiator": _STR,
                "industry_code": {"enum": list(INDUSTRY_CODES)},
                "industry_confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "interpretation": {"enum": list(INTERPRETATIONS)},
                "alternative_interpretation": _STR,
            }
        ),
        "verdict": _obj({"grade": {"enum": list(GRADES)}, "decision": _STR, "one_liner": _STR}),
        "assumptions": {"type": "array", "minItems": 1, "items": _ref("assumption")},
        "scores": _obj({a: _nullable(_ref("score_adjusted")) for a in AXES}),
        "market": _nullable(_obj(MARKET_BODY)),
        "roi": _nullable(_obj(FINANCE_BODY)),
        "feasibility": _nullable(_obj(EXECUTION_BODY)),
        "critique": _nullable(CRITIC_SCHEMA),
        # 3단계가 원칙이나, Synthesizer 실패 시 빈 배열 + degraded_sections["roadmap"]으로 진행한다.
        "roadmap": {"type": "array", "maxItems": 3, "items": _ROADMAP_STAGE},
        "sources": {
            "type": "array",
            "items": _obj({"title": {"type": "string"}, "url": _STR, "used_for": {"type": "string"}}),
        },
        "degraded_sections": {"type": "array", "items": {"enum": list(DEGRADABLE_SECTIONS)}},
    }
)
REPORT_SCHEMA["$defs"] = DEFS
# critique 안의 $defs 참조는 최상위 $defs로 해결되므로 내부 $defs 중복 제거
if isinstance(REPORT_SCHEMA["properties"]["critique"]["anyOf"][0], dict):
    REPORT_SCHEMA["properties"]["critique"]["anyOf"][0].pop("$defs", None)

# Synthesizer가 LLM에게 실제로 시키는 것은 판정문·가정·로드맵뿐이다.
# (시장·ROI·실행 섹션은 이미 검증된 결과를 코드가 그대로 옮기고, 등급은 코드가 계산한다.)
SYNTH_LLM_SCHEMA = _obj(
    {
        "one_liner": _STR,
        "assumptions": {"type": "array", "minItems": 3, "maxItems": 6, "items": _ref("assumption")},
        "roadmap": {"type": "array", "minItems": 3, "maxItems": 3, "items": _ROADMAP_STAGE},
    }
)
SYNTH_LLM_SCHEMA["$defs"] = DEFS

# agent_id 6종 외에 내부적으로만 쓰는 스키마
EXTRA_SCHEMAS: dict[str, dict] = {"synthesizer_llm": SYNTH_LLM_SCHEMA}

SCHEMAS: dict[str, dict] = {
    "normalizer": NORMALIZER_SCHEMA,
    "market": _agent_schema(MARKET_BODY, ("market", "competition")),
    "finance": _agent_schema(FINANCE_BODY, ("profitability",)),
    "execution": _agent_schema(EXECUTION_BODY, ("execution", "risk")),
    "critic": CRITIC_SCHEMA,
    "synthesizer": REPORT_SCHEMA,
}


# ---------------------------------------------------------------- JSON 추출·숫자 정규화
_FENCE = re.compile(r"^\s*```[a-zA-Z]*\s*|\s*```\s*$")


def extract_json(text: str) -> Any:
    """LLM 출력에서 JSON을 꺼낸다. 마크다운 백틱·앞뒤 잡담이 붙어도 복구한다."""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("빈 응답")
    cleaned = _FENCE.sub("", text.strip()).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("JSON 객체를 찾을 수 없음")
    return json.loads(cleaned[start : end + 1])


def _norm_url(url: str) -> str:
    return url.strip().rstrip("/").lower()


def _looks_like_number(d: dict) -> bool:
    return isinstance(d, dict) and "value" in d and "unit" in d


def normalize_numbers(data: Any, allowed_urls: Optional[Iterable[str]] = None) -> Any:
    """숫자 객체를 정규화한다(원본은 수정하지 않고 복사본 반환).

    - source_url이 None/비어 있으면 "" 로 통일
    - allowed_urls가 주어지면, 그 목록에 없는 URL(= 모델이 지어낸 링크)은 제거
    - source_url이 비면 confidence를 "estimated"로 강제, 있으면 "sourced"
    - "3,200" 같은 문자열 숫자는 float로 변환
    """
    allowed = {_norm_url(u) for u in allowed_urls} if allowed_urls is not None else None

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(x) for x in node]
        if not isinstance(node, dict):
            return node
        out = {k: walk(v) for k, v in node.items()}
        if _looks_like_number(out):
            url = out.get("source_url")
            url = url.strip() if isinstance(url, str) else ""
            if url and allowed is not None and _norm_url(url) not in allowed:
                url = ""
            out["source_url"] = url
            out["confidence"] = "sourced" if url else "estimated"
            if isinstance(out["value"], str):
                try:
                    out["value"] = float(out["value"].replace(",", "").strip())
                except ValueError:
                    pass
        return out

    return walk(copy.deepcopy(data))


# ---------------------------------------------------------------- 검증
def _extra_checks(agent_id: str, data: dict) -> list[str]:
    errors: list[str] = []
    if agent_id == "critic":
        angles = [o.get("angle") for o in data.get("objections", [])]
        if sorted(angles) != sorted(OBJECTION_ANGLES):
            errors.append(f"objections: 반론 각도는 {list(OBJECTION_ANGLES)} 3종을 한 번씩 써야 한다 (받은 값: {angles})")
        axes = [a.get("axis") for a in data.get("adjustments", [])]
        if len(axes) != len(set(axes)):
            errors.append("adjustments: 같은 축을 두 번 조정할 수 없다")
    if agent_id == "synthesizer":
        degraded = set(data.get("degraded_sections", []))
        for key in DEGRADABLE_SECTIONS:
            empty = data.get(key) is None or (key == "roadmap" and not data.get(key))
            if empty and key not in degraded:
                errors.append(f"{key}: 값이 비면 degraded_sections에 '{key}'를 넣어야 한다")
        if data.get("roadmap") and len(data["roadmap"]) != 3:
            errors.append("roadmap: 3단계이거나 빈 배열이어야 한다")
    return errors


def validate(agent_id: str, data: Any) -> list[str]:
    """스키마 위반 메시지 목록을 반환한다. 빈 리스트면 통과."""
    target = SCHEMAS.get(agent_id) or EXTRA_SCHEMAS.get(agent_id)
    if target is None:
        raise KeyError(f"알 수 없는 agent_id: {agent_id}")
    if not isinstance(data, dict):
        return ["최상위 값이 JSON 객체가 아니다"]
    validator = Draft202012Validator(target)
    errors = []
    for err in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        path = ".".join(str(p) for p in err.absolute_path) or "(root)"
        errors.append(f"{path}: {err.message[:160]}")
    if not errors:
        errors.extend(_extra_checks(agent_id, data))
    return errors


# ---------------------------------------------------------------- 재시도
@dataclass
class AgentResult:
    agent_id: str
    ok: bool
    data: Optional[dict] = None
    errors: list[str] = field(default_factory=list)
    attempts: int = 0
    raw: str = ""
    history: list[list[str]] = field(default_factory=list)  # 시도별 오류(성공해도 남는다 → 재시도 원인 추적용)


def run_with_retry(
    agent_id: str,
    call_fn: Callable[[Optional[str]], str],
    allowed_urls: Optional[Iterable[str]] = None,
    max_retries: int = 1,
    checks: Optional[Callable[[dict], list[str]]] = None,
) -> AgentResult:
    """call_fn(feedback) -> 원문 텍스트. 실패하면 오류 피드백을 붙여 max_retries번 재시도한다.

    API 예외·JSON 파싱 실패·스키마 위반은 모두 '실패한 시도'로 센다.
    최종 실패 시 ok=False를 돌려주며 예외를 던지지 않는다(전체 중단 금지).
    """
    feedback: Optional[str] = None
    errors: list[str] = []
    history: list[list[str]] = []
    raw = ""
    attempts = 0
    for attempts in range(1, max_retries + 2):
        data = None
        try:
            raw = call_fn(feedback)
            data = normalize_numbers(extract_json(raw), allowed_urls)
            errors = validate(agent_id, data)
            if not errors and checks:
                errors = checks(data)  # 스키마 밖의 도메인 검증(단위·항목 수 등)
        except Exception as exc:  # noqa: BLE001 - API·파싱 오류도 재시도 대상
            errors = [f"{type(exc).__name__}: {exc}"]
        history.append(errors)
        if not errors:
            return AgentResult(agent_id, True, data, [], attempts, raw, history)
        feedback = "직전 출력이 아래 오류로 거부되었다. 설명 없이 수정된 JSON 객체만 다시 출력하라.\n- " + "\n- ".join(errors[:8])
    return AgentResult(agent_id, False, None, errors, attempts, raw, history)
