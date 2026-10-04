import { AXES, OBJECTION_ANGLES, type Json } from "@/lib/schema";

export const N = (value: unknown, unit: string, url = "https://example.com/a", conf = "sourced") => ({
  value,
  unit,
  source_url: url,
  confidence: conf,
});
export const score = (s = 6, ref = "market:5-6") => ({ score: s, rubric_ref: ref, rationale: "근거 문장" });
export const clone = <T,>(x: T): T => structuredClone(x);

export const ASSUMPTION = { key: "초기자본", value: "3,000만원", reason: "업종 표준" };

export const NORMALIZER: Json = {
  product: "발열 폼롤러",
  target: "홈트 인구",
  differentiator: "온열+압박",
  industry_code: "manufacturing",
  industry_confidence: 0.7,
  interpretation: "oem_import",
  alternative_interpretation: "자체 제조로 볼 경우 초기투자 약 3배",
  assumptions: [ASSUMPTION, ASSUMPTION, ASSUMPTION],
  queries: Array.from({ length: 7 }, (_, i) => `쿼리 ${i}`),
};

export const MARKET: Json = {
  scores: { market: score(7, "market:7-8"), competition: score(3, "competition:3-4") },
  summary: "시장은 있으나 경쟁이 강하다.",
  size: N(3200, "억원"),
  growth: N(9, "%"),
  competition_level: "상",
  competitors: [{ name: "A사", positioning: "저가", url: "https://a.com", note: "" }],
  trends: ["트렌드1", "트렌드2", "트렌드3"],
};

const SC = { monthly_units: N(200, "개", "", "estimated"), cumulative_profit_12m: N(400, "만원", "", "estimated"), note: "n" };
export const FINANCE: Json = {
  scores: { profitability: score(6, "profitability:5-6") },
  summary: "손익분기는 월 88개이다.",
  initial_investment: [{ item: "금형", amount: N(1200, "만원", "", "estimated") }],
  total_initial_investment: N(3000, "만원", "", "estimated"),
  fixed_cost_monthly: N(300, "만원", "", "estimated"),
  unit_economics: {
    price: N(69000, "원"),
    unit_cost: N(23000, "원", "", "estimated"),
    variable_cost: N(12000, "원", "", "estimated"),
    contribution_margin: N(34000, "원", "", "estimated"),
  },
  break_even: { units_per_month: N(88, "개", "", "estimated"), payback_months: N(9, "개월", "", "estimated") },
  scenarios: { conservative: clone(SC), base: clone(SC), optimistic: clone(SC) },
};

const LB = { level: "중", summary: "요약", detail: "상세" };
export const EXECUTION: Json = {
  scores: { execution: score(5, "execution:5-6"), risk: score(4, "risk:3-4") },
  summary: "KC 인증이 최대 변수다.",
  tech: LB,
  capital: LB,
  people: LB,
  regulation: { ...LB, lead_time_weeks: N(8, "주") },
};

export const CRITIC: Json = {
  objections: OBJECTION_ANGLES.map((a) => ({ angle: a, claim: "주장", evidence: "근거", evidence_url: "https://x.com" })),
  adjustments: [{ axis: "market", delta: -1, reason: "사유", evidence_url: "https://x.com" }],
};

const omitScores = (x: Json) => {
  const { scores: _s, ...rest } = x;
  return rest;
};

export const REPORT: Json = {
  idea_raw: "따뜻한 폼롤러",
  normalized: Object.fromEntries(
    ["product", "target", "differentiator", "industry_code", "industry_confidence", "interpretation", "alternative_interpretation"].map(
      (k) => [k, NORMALIZER[k]],
    ),
  ),
  verdict: { grade: "B-", decision: "조건부 진행", one_liner: "판정" },
  assumptions: [ASSUMPTION],
  scores: Object.fromEntries(AXES.map((a) => [a, { ...score(), adjusted_from: null }])),
  market: omitScores(MARKET),
  roi: omitScores(FINANCE),
  feasibility: omitScores(EXECUTION),
  critique: CRITIC,
  roadmap: [0, 1, 2].map((i) => ({
    stage: `${i}단계`,
    period: "0~4주",
    actions: ["할 일"],
    cost: N(100, "만원", "", "estimated"),
    gate_condition: "조건",
  })),
  sources: [{ title: "t", url: "https://a.com", used_for: "시장" }],
  degraded_sections: [],
};

export const VALID: Record<string, Json> = {
  normalizer: NORMALIZER,
  market: MARKET,
  finance: FINANCE,
  execution: EXECUTION,
  critic: CRITIC,
  synthesizer: REPORT,
};
