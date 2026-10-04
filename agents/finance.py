"""Finance: 초기투자·월 고정비·단위경제·BEP·12개월 3시나리오 + 수익성 점수.

LLM은 입력 숫자(투자 항목, 고정비, 판매가, 원가, 변동비, 정상 궤도 월 판매량)만 정한다.
기여이익·손익분기·시나리오 누적손익·수익성 점수 구간은 roi_simulator.md 규칙대로 코드가 계산해 덮어쓴다.
"""
from __future__ import annotations

import json
import math

import schema
from search_pool import SearchPool

from . import Emit, load_params, noop_emit, read_skill
from .base import COMMON_RULES, context_header, rubric_block, run_agent

AGENT_ID = "finance"

_N = '{"value": 숫자, "unit": "%s", "source_url": "", "confidence": "estimated"}'


def _n(unit: str) -> str:
    return _N % unit


_TEMPLATE = f"""{{
  "scores": {{"profitability": {{"rubric_ref": "profitability:5-6", "score": 6, "rationale": "결론 문장 + 근거. 계산 결과 숫자(BEP·기여이익)는 쓰지 말 것"}}}},
  "summary": "손익분기 숫자 없이, 가정(판매가·원가율·채널·초기자본)과 수익 구조의 핵심을 결론 문장으로 시작해 2문장",
  "initial_investment": [{{"item": "표의 label 그대로", "amount": {_n('만원')}}}],
  "total_initial_investment": {_n('만원')},
  "fixed_cost_monthly": {_n('만원')},
  "unit_economics": {{
    "price": {_n('원')},
    "unit_cost": {_n('원')},
    "variable_cost": {_n('원')},
    "contribution_margin": {_n('원')}
  }},
  "break_even": {{"units_per_month": {_n('개')}, "payback_months": {_n('개월')}}},
  "scenarios": {{
    "conservative": {{"monthly_units": {_n('개')}, "cumulative_profit_12m": {_n('만원')}, "note": ""}},
    "base":         {{"monthly_units": {_n('개')}, "cumulative_profit_12m": {_n('만원')}, "note": "정상 궤도 월 판매량의 근거"}},
    "optimistic":   {{"monthly_units": {_n('개')}, "cumulative_profit_12m": {_n('만원')}, "note": ""}}
  }}
}}"""


def select_params(norm: dict) -> dict:
    """정규화 결과의 업종·해석에 맞는 파라미터 표(코드 고정 구조)를 고른다."""
    params = load_params()
    ind = params["industries"][norm["industry_code"]]
    if ind.get("refined"):
        interp = norm.get("interpretation")
        if interp not in ind["interpretations"]:
            interp = ind["default_interpretation"]
        table = ind["interpretations"][interp]
        return {
            "industry": ind["label"],
            "interpretation": table["label"],
            "investment_items": table["investment_items"],
            "monthly_fixed_items": ind["monthly_fixed_items"],
            "unit_economics_defaults": ind["unit_economics_defaults"],
            "lead_times_weeks": ind.get("lead_times_weeks", {}),
        }
    g = params["generic_defaults"]
    return {
        "industry": ind["label"] + " (범용 기본값)",
        "interpretation": "default",
        "hints": ind.get("hints", ""),
        "unit_name": ind.get("unit_name", "건"),
        **g,
    }


def _system(table: dict) -> str:
    return f"""너는 투자 심사역 팀의 재무 분석 담당(Finance)이다. 검색 자료와 업종 파라미터 표를 근거로 초기투자, 월 고정비, 단위경제, 12개월 시나리오의 **입력 숫자**를 채우고 수익성 축을 채점한다.

{COMMON_RULES}

[담당 규칙]
- 단위: 초기투자·월 고정비·총투자는 "만원", 판매가·원가·변동비는 "원", 판매량은 "개".
- initial_investment는 아래 업종 파라미터 표의 investment_items와 **같은 항목 수·같은 label**로 쓴다. 항목을 더하거나 빼지 마라. amount는 표의 low/base/high 중 검색 근거에 가장 가까운 값이거나, 검색 근거가 있으면 그 값이다.
- fixed_cost_monthly는 monthly_fixed_items의 합에 근거한 월 고정비 합계다.
- 판매가(price)는 검색으로 확인된 경쟁 제품 가격대에서 잡고, 근거가 있으면 source_url을 붙인다. 원가·변동비는 표의 unit_cost_ratio와 각 비율(수수료·광고·반품)과 배송비로 산출한다. variable_cost = 판매가×(channel_fee_rate+ad_cost_rate+return_rate) + shipping_per_order_won.
- 정상 궤도 월 판매량은 scenarios.base.monthly_units 하나만 정한다(근거는 note). 초기 자본과 채널 규모에서 현실적인 값으로 잡는다.
- **계산 결과 필드는 코드가 다시 계산해 덮어쓰므로 값을 0으로 둔다**: contribution_margin, break_even.*, scenarios.conservative/optimistic.monthly_units, 세 시나리오의 cumulative_profit_12m.
- 그래서 summary와 rationale에 손익분기 판매량·기여이익 같은 계산 결과 숫자를 쓰지 마라.
- 초기 자본(assumptions)보다 총 초기투자가 지나치게 크면 summary에 그 사실을 명시한다.

[업종 파라미터 표 — 이 구조를 벗어나지 말 것]
{json.dumps(table, ensure_ascii=False, indent=2)}

{read_skill("roi_simulator")}

{rubric_block()}

[출력 스키마 — 이 구조 그대로]
{_TEMPLATE}"""


# ---------------------------------------------------------------- 검증(단위·항목 수)
def _make_checks(table: dict):
    n_items = len(table["investment_items"])
    labels = [i["label"] for i in table["investment_items"]]

    def checks(data: dict) -> list[str]:
        errs: list[str] = []
        if len(data["initial_investment"]) != n_items:
            errs.append(f"initial_investment: 항목은 표와 같은 {n_items}개여야 한다 ({labels})")
        for it in data["initial_investment"]:
            if it["amount"]["unit"] != "만원":
                errs.append(f"initial_investment[{it['item']}]: 단위는 '만원'이어야 한다")
        if data["fixed_cost_monthly"]["unit"] != "만원":
            errs.append("fixed_cost_monthly: 단위는 '만원'이어야 한다")
        ue = data["unit_economics"]
        for k in ("price", "unit_cost", "variable_cost"):
            if ue[k]["unit"] != "원":
                errs.append(f"unit_economics.{k}: 단위는 '원'이어야 한다")
        if ue["price"]["value"] <= 0:
            errs.append("unit_economics.price: 0보다 커야 한다")
        if ue["unit_cost"]["value"] < 0 or ue["variable_cost"]["value"] < 0:
            errs.append("unit_economics: 원가·변동비는 음수일 수 없다")
        if data["scenarios"]["base"]["monthly_units"]["value"] <= 0:
            errs.append("scenarios.base.monthly_units: 0보다 커야 한다")
        return errs

    return checks


# ---------------------------------------------------------------- 코드 계산
def _calc_num(value: float, unit: str, note: str = "계산값") -> dict:
    return {"value": value, "unit": unit, "source_url": "", "confidence": "estimated", "note": note}


def profitability_band(margin_rate: float, bep_ratio: float, base_cum_12m: float, monthly_profit: float, payback: float) -> tuple[int, int]:
    """viability_rubric.md의 profitability 앵커를 코드로 옮긴 것. 경계는 낮은 쪽."""
    if margin_rate < 0.10 or monthly_profit <= 0:
        return 0, 2
    if margin_rate < 0.20 or base_cum_12m < 0:
        return 3, 4
    if margin_rate < 0.35 or bep_ratio > 0.60:
        return 5, 6
    if margin_rate < 0.50 or bep_ratio > 0.30 or payback > 6:
        return 7, 8
    return 9, 10


def recompute(data: dict) -> dict:
    """LLM 입력값으로 기여이익·BEP·시나리오·수익성 점수를 다시 계산해 덮어쓴다(in-place)."""
    sm = load_params()["scenario_model"]
    ramp, mult = sm["ramp"], sm["volume_multiplier"]

    inv_total = sum(i["amount"]["value"] for i in data["initial_investment"])
    fixed = data["fixed_cost_monthly"]["value"]
    ue = data["unit_economics"]
    price, cost, var = ue["price"]["value"], ue["unit_cost"]["value"], ue["variable_cost"]["value"]
    cm = price - cost - var
    steady = data["scenarios"]["base"]["monthly_units"]["value"]

    data["total_initial_investment"] = _calc_num(round(inv_total), "만원", "항목 합계")
    ue["contribution_margin"] = _calc_num(round(cm), "원")

    if cm > 0:
        bep = math.ceil(fixed * 10000 / cm)
        bep_note = "월 고정비 ÷ 개당 기여이익"
    else:
        bep, bep_note = 0, "개당 기여이익이 0 이하라 손익분기에 도달할 수 없음"
    data["break_even"]["units_per_month"] = _calc_num(bep, "개", bep_note)

    monthly_profit = (steady * cm - fixed * 10000) / 10000  # 만원, 정상 궤도
    if monthly_profit > 0:
        payback, pb_note = round(inv_total / monthly_profit, 1), "총 초기투자 ÷ 정상 궤도 월 순이익"
    else:
        payback, pb_note = 0, "정상 궤도에서도 월 순이익이 0 이하라 회수 불가"
    data["break_even"]["payback_months"] = _calc_num(payback, "개월", pb_note)

    base_units_num = data["scenarios"]["base"]["monthly_units"]  # LLM이 정한 유일한 판매량 입력
    for name in ("conservative", "base", "optimistic"):
        units_steady = steady * mult[name]
        total_units = sum(units_steady * r for r in ramp)
        cum = total_units * cm / 10000 - fixed * 12 - inv_total
        sc = data["scenarios"][name]
        if name == "base":
            sc["monthly_units"] = {**base_units_num, "value": round(units_steady)}
        else:
            sc["monthly_units"] = _calc_num(round(units_steady), "개", f"기본 시나리오 × {mult[name]}")
        sc["cumulative_profit_12m"] = _calc_num(round(cum), "만원", "12개월 누적 손익(초기투자 포함, 세전)")

    margin_rate = cm / price if price else 0
    bep_ratio = bep / steady if steady else 9
    base_cum = data["scenarios"]["base"]["cumulative_profit_12m"]["value"]
    lo, hi = profitability_band(margin_rate, bep_ratio, base_cum, monthly_profit, payback if payback else 99)
    sc_ = data["scores"]["profitability"]
    original = sc_["score"]
    sc_["score"] = min(max(original, lo), hi)
    sc_["rubric_ref"] = f"profitability:{lo}-{hi}"
    if sc_["score"] != original:
        sc_["rationale"] += f" (계산된 기여이익률 {margin_rate:.0%}·BEP 비율 {bep_ratio:.0%}에 맞춰 {original}→{sc_['score']}점으로 조정)"

    base_cum_txt = f"{base_cum:,.0f}만원"
    data["summary"] = (
        f"손익분기는 월 {bep:,}개, 기본 시나리오 12개월 누적 손익은 {base_cum_txt}이다"
        if cm > 0
        else "개당 기여이익이 0 이하라 손익분기에 도달하지 못한다"
    ) + ". " + data["summary"]
    data["_derived"] = {"margin_rate": round(margin_rate, 3), "bep_ratio": round(bep_ratio, 3), "monthly_profit_manwon": round(monthly_profit, 1)}
    return data


def run(norm: dict, pool: SearchPool, emit: Emit = noop_emit, force_fail: bool = False) -> schema.AgentResult:
    table = select_params(norm)
    user = context_header(norm) + "\n\n" + pool.to_prompt_block()
    result = run_agent(
        AGENT_ID, _system(table), user, emit,
        allowed_urls=pool.allowed_urls, start_note="원가·손익분기 계산 중",
        force_fail=force_fail, checks=_make_checks(table),
    )
    if result.ok:
        recompute(result.data)
        bep = result.data["break_even"]["units_per_month"]["value"]
        emit(AGENT_ID, "done", f"손익분기 월 {bep:,.0f}개" if bep else "손익분기 도달 불가")
    return result
