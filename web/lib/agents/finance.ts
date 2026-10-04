/**
 * Finance: 초기투자·월 고정비·단위경제·BEP·12개월 3시나리오 + 수익성 점수.
 *
 * LLM은 입력 숫자(투자 항목, 고정비, 판매가, 원가, 변동비, 정상 궤도 월 판매량)만 정한다.
 * 기여이익·손익분기·시나리오 누적손익·수익성 점수 구간은 roi_simulator.md 규칙대로 코드가 계산해 덮어쓴다.
 */
import type { SearchPool } from "@/lib/searchPool";
import type { AgentResult, Json } from "@/lib/schema";
import { COMMON_RULES, comma, contextHeader, loadParams, readSkill, rubricBlock, runAgent, type RunCtx } from "./base";

const AGENT_ID = "finance";

const n = (unit: string) => `{"value": 숫자, "unit": "${unit}", "source_url": "", "confidence": "estimated"}`;

const TEMPLATE = `{
  "scores": {"profitability": {"rubric_ref": "profitability:5-6", "score": 6, "rationale": "결론 문장 + 근거. 계산 결과 숫자(BEP·기여이익)는 쓰지 말 것"}},
  "summary": "손익분기 숫자 없이, 가정(판매가·원가율·채널·초기자본)과 수익 구조의 핵심을 결론 문장으로 시작해 2문장",
  "initial_investment": [{"item": "표의 label 그대로", "amount": ${n("만원")}}],
  "total_initial_investment": ${n("만원")},
  "fixed_cost_monthly": ${n("만원")},
  "unit_economics": {
    "price": ${n("원")},
    "unit_cost": ${n("원")},
    "variable_cost": ${n("원")},
    "contribution_margin": ${n("원")}
  },
  "break_even": {"units_per_month": ${n("개")}, "payback_months": ${n("개월")}},
  "scenarios": {
    "conservative": {"monthly_units": ${n("개")}, "cumulative_profit_12m": ${n("만원")}, "note": ""},
    "base":         {"monthly_units": ${n("개")}, "cumulative_profit_12m": ${n("만원")}, "note": "정상 궤도 월 판매량의 근거"},
    "optimistic":   {"monthly_units": ${n("개")}, "cumulative_profit_12m": ${n("만원")}, "note": ""}
  }
}`;

/** 정규화 결과의 업종·해석에 맞는 파라미터 표(코드 고정 구조)를 고른다. */
export function selectParams(norm: Json): Json {
  const params = loadParams();
  const ind = params.industries[norm.industry_code];
  if (ind.refined) {
    let interp = norm.interpretation;
    if (!(interp in ind.interpretations)) interp = ind.default_interpretation;
    const table = ind.interpretations[interp];
    return {
      industry: ind.label,
      interpretation: table.label,
      investment_items: table.investment_items,
      monthly_fixed_items: ind.monthly_fixed_items,
      unit_economics_defaults: ind.unit_economics_defaults,
      lead_times_weeks: ind.lead_times_weeks ?? {},
    };
  }
  return {
    industry: ind.label + " (범용 기본값)",
    interpretation: "default",
    hints: ind.hints ?? "",
    unit_name: ind.unit_name ?? "건",
    ...params.generic_defaults,
  };
}

const system = (table: Json) => `너는 투자 심사역 팀의 재무 분석 담당(Finance)이다. 검색 자료와 업종 파라미터 표를 근거로 초기투자, 월 고정비, 단위경제, 12개월 시나리오의 **입력 숫자**를 채우고 수익성 축을 채점한다.

${COMMON_RULES}

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
${JSON.stringify(table, null, 2)}

${readSkill("roi_simulator")}

${rubricBlock()}

[출력 스키마 — 이 구조 그대로]
${TEMPLATE}`;

// ---------------------------------------------------------------- 검증(단위·항목 수)
function makeChecks(table: Json) {
  const nItems = table.investment_items.length;
  const labels = table.investment_items.map((i: Json) => i.label);

  return (data: Json): string[] => {
    const errs: string[] = [];
    if (data.initial_investment.length !== nItems) {
      errs.push(`initial_investment: 항목은 표와 같은 ${nItems}개여야 한다 (${JSON.stringify(labels)})`);
    }
    for (const it of data.initial_investment) {
      if (it.amount.unit !== "만원") errs.push(`initial_investment[${it.item}]: 단위는 '만원'이어야 한다`);
    }
    if (data.fixed_cost_monthly.unit !== "만원") errs.push("fixed_cost_monthly: 단위는 '만원'이어야 한다");
    const ue = data.unit_economics;
    for (const k of ["price", "unit_cost", "variable_cost"]) {
      if (ue[k].unit !== "원") errs.push(`unit_economics.${k}: 단위는 '원'이어야 한다`);
    }
    if (ue.price.value <= 0) errs.push("unit_economics.price: 0보다 커야 한다");
    if (ue.unit_cost.value < 0 || ue.variable_cost.value < 0) errs.push("unit_economics: 원가·변동비는 음수일 수 없다");
    if (data.scenarios.base.monthly_units.value <= 0) errs.push("scenarios.base.monthly_units: 0보다 커야 한다");
    return errs;
  };
}

// ---------------------------------------------------------------- 코드 계산
const calcNum = (value: number, unit: string, note = "계산값") => ({
  value,
  unit,
  source_url: "",
  confidence: "estimated",
  note,
});

const round1 = (x: number) => Math.round(x * 10) / 10;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** viability_rubric.md의 profitability 앵커를 코드로 옮긴 것. 경계는 낮은 쪽. */
export function profitabilityBand(
  marginRate: number,
  bepRatio: number,
  baseCum12m: number,
  monthlyProfit: number,
  payback: number,
): [number, number] {
  if (marginRate < 0.1 || monthlyProfit <= 0) return [0, 2];
  if (marginRate < 0.2 || baseCum12m < 0) return [3, 4];
  if (marginRate < 0.35 || bepRatio > 0.6) return [5, 6];
  if (marginRate < 0.5 || bepRatio > 0.3 || payback > 6) return [7, 8];
  return [9, 10];
}

/** LLM 입력값으로 기여이익·BEP·시나리오·수익성 점수를 다시 계산해 덮어쓴다(in-place). */
export function recompute(data: Json): Json {
  const sm = loadParams().scenario_model;
  const ramp: number[] = sm.ramp;
  const mult: Record<string, number> = sm.volume_multiplier;

  const invTotal: number = data.initial_investment.reduce((s: number, i: Json) => s + i.amount.value, 0);
  const fixed: number = data.fixed_cost_monthly.value;
  const ue = data.unit_economics;
  const price: number = ue.price.value;
  const cost: number = ue.unit_cost.value;
  const variable: number = ue.variable_cost.value;
  const cm = price - cost - variable;
  const steady: number = data.scenarios.base.monthly_units.value;

  data.total_initial_investment = calcNum(Math.round(invTotal), "만원", "항목 합계");
  ue.contribution_margin = calcNum(Math.round(cm), "원");

  let bep: number;
  let bepNote: string;
  if (cm > 0) {
    bep = Math.ceil((fixed * 10000) / cm);
    bepNote = "월 고정비 ÷ 개당 기여이익";
  } else {
    bep = 0;
    bepNote = "개당 기여이익이 0 이하라 손익분기에 도달할 수 없음";
  }
  data.break_even.units_per_month = calcNum(bep, "개", bepNote);

  const monthlyProfit = (steady * cm - fixed * 10000) / 10000; // 만원, 정상 궤도
  let payback: number;
  let pbNote: string;
  if (monthlyProfit > 0) {
    payback = round1(invTotal / monthlyProfit);
    pbNote = "총 초기투자 ÷ 정상 궤도 월 순이익";
  } else {
    payback = 0;
    pbNote = "정상 궤도에서도 월 순이익이 0 이하라 회수 불가";
  }
  data.break_even.payback_months = calcNum(payback, "개월", pbNote);

  const baseUnitsNum = data.scenarios.base.monthly_units; // LLM이 정한 유일한 판매량 입력
  for (const name of ["conservative", "base", "optimistic"]) {
    const unitsSteady = steady * mult[name];
    const totalUnits = ramp.reduce((s, r) => s + unitsSteady * r, 0);
    const cum = (totalUnits * cm) / 10000 - fixed * 12 - invTotal;
    const sc = data.scenarios[name];
    if (name === "base") sc.monthly_units = { ...baseUnitsNum, value: Math.round(unitsSteady) };
    else sc.monthly_units = calcNum(Math.round(unitsSteady), "개", `기본 시나리오 × ${mult[name]}`);
    sc.cumulative_profit_12m = calcNum(Math.round(cum), "만원", "12개월 누적 손익(초기투자 포함, 세전)");
  }

  const marginRate = price ? cm / price : 0;
  const bepRatio = steady ? bep / steady : 9;
  const baseCum: number = data.scenarios.base.cumulative_profit_12m.value;
  const [lo, hi] = profitabilityBand(marginRate, bepRatio, baseCum, monthlyProfit, payback || 99);
  const sc = data.scores.profitability;
  const original: number = sc.score;
  sc.score = Math.min(Math.max(original, lo), hi);
  sc.rubric_ref = `profitability:${lo}-${hi}`;
  if (sc.score !== original) {
    sc.rationale += ` (계산된 기여이익률 ${Math.round(marginRate * 100)}%·BEP 비율 ${Math.round(bepRatio * 100)}%에 맞춰 ${original}→${sc.score}점으로 조정)`;
  }

  data.summary =
    (cm > 0
      ? `손익분기는 월 ${comma(bep)}개, 기본 시나리오 12개월 누적 손익은 ${comma(baseCum)}만원이다`
      : "개당 기여이익이 0 이하라 손익분기에 도달하지 못한다") +
    ". " +
    data.summary;
  data._derived = {
    margin_rate: round3(marginRate),
    bep_ratio: round3(bepRatio),
    monthly_profit_manwon: round1(monthlyProfit),
  };
  return data;
}

export async function run(norm: Json, pool: SearchPool, ctx: RunCtx, forceFail = false): Promise<AgentResult> {
  const table = selectParams(norm);
  const user = contextHeader(norm) + "\n\n" + pool.toPromptBlock();
  const result = await runAgent(AGENT_ID, system(table), user, ctx, {
    allowedUrls: pool.allowedUrls,
    startNote: "원가·손익분기 계산 중",
    forceFail,
    checks: makeChecks(table),
  });
  if (result.ok) {
    recompute(result.data);
    const bep = result.data.break_even.units_per_month.value;
    ctx.emit(AGENT_ID, "done", bep ? `손익분기 월 ${comma(bep)}개` : "손익분기 도달 불가");
  }
  return result;
}
