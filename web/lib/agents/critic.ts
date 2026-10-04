/** Critic: 고정 3각도 반론 + 축별 조정 제안(-2~0). 1회만 실행하며 점수를 직접 수정하지 않는다. */
import { CRITIC_MODEL } from "@/lib/llm";
import type { SearchPool } from "@/lib/searchPool";
import { normUrl, type AgentResult, type Json } from "@/lib/schema";
import { COMMON_RULES, contextHeader, runAgent, type RunCtx } from "./base";

const AGENT_ID = "critic";

const TEMPLATE = `{
  "objections": [
    {"angle": "이미 존재한다", "claim": "반론 주장 1~2문장", "evidence": "검색 자료에서 확인한 근거", "evidence_url": "출처 후보 목록의 URL 또는 빈 문자열"},
    {"angle": "숨은 비용", "claim": "...", "evidence": "...", "evidence_url": ""},
    {"angle": "고객이 돈을 안 낸다", "claim": "...", "evidence": "...", "evidence_url": ""}
  ],
  "adjustments": [
    {"axis": "market|competition|execution|profitability|risk", "delta": -2에서 0 사이 정수, "reason": "조정 사유 1문장", "evidence_url": "근거 URL"}
  ]
}`;

const system = () => `너는 투자 심사역 팀의 비평가(Critic)다. 동료들이 낸 분석의 낙관 편향을 공격한다. 단, 근거 없는 트집은 잡지 않는다.

${COMMON_RULES}

[반론 각도 — 정확히 3개, 각각 1개씩]
1. "이미 존재한다": 이 아이디어의 차별점이 시장에 이미 있는가? 검색 자료에서 동일·유사 제품을 찾아 제시한다.
2. "숨은 비용": 재무 분석이 빠뜨린 비용(인증·규제·반품·수수료·재고·A/S)이 있는가?
3. "고객이 돈을 안 낸다": 문제는 진짜지만 고객이 이 가격에 지갑을 열 만큼 아픈가? 저가 대체재·무료 대안을 짚는다.

[조정 제안 규칙 — 반드시 지킬 것]
- 너는 점수를 직접 수정할 수 없다. 축별 delta만 제안한다. delta는 -2, -1, 0 중 하나다(양수 금지).
- 조정은 최대 3개 축까지, 같은 축을 두 번 제안하지 않는다.
- **evidence_url이 '출처 후보 목록'에 실제로 있는 조정만 반영된다.** 근거 URL이 없으면 그 조정은 버려지므로, 근거를 댈 수 없는 축은 아예 제안하지 마라.
- 이미 낮은 점수(3점 이하)를 더 깎지 마라. 모든 아이디어를 D등급으로 만드는 것이 네 역할이 아니다.
- 반론 자체는 근거 URL이 없어도 제기할 수 있다(evidence_url은 빈 문자열). 다만 그 경우 점수 조정은 하지 못한다.

[출력 스키마 — 이 구조 그대로]
${TEMPLATE}`;

/** 비평에 필요한 주장·핵심 숫자만 추린다. 전체 JSON을 넘기면 입력이 커져 응답이 느려진다. */
function digest(sections: Record<string, Json>): Json {
  const out: Json = {};
  const { market: m, finance: f, execution: e } = sections;
  if (m) {
    out["시장"] = {
      요약: m.summary,
      규모: m.size,
      성장률: m.growth,
      경쟁강도: m.competition_level,
      경쟁사: m.competitors.map((c: Json) => `${c.name} — ${c.positioning}`),
      트렌드: m.trends,
    };
  }
  if (f) {
    const ue = f.unit_economics;
    out["재무"] = {
      요약: f.summary,
      초기투자: Object.fromEntries(f.initial_investment.map((i: Json) => [i.item, i.amount.value])),
      "총투자(만원)": f.total_initial_investment.value,
      "월고정비(만원)": f.fixed_cost_monthly.value,
      "판매가/원가/변동비(원)": [ue.price.value, ue.unit_cost.value, ue.variable_cost.value],
      "손익분기(월 개수)": f.break_even.units_per_month.value,
      "기본시나리오 12개월 누적(만원)": f.scenarios.base.cumulative_profit_12m.value,
    };
  }
  if (e) {
    out["실행"] = {
      요약: e.summary,
      ...Object.fromEntries(["tech", "capital", "people", "regulation"].map((k) => [k, `${e[k].level} — ${e[k].summary}`])),
    };
  }
  return out;
}

export async function run(
  norm: Json,
  pool: SearchPool,
  draft: Json,
  sections: Record<string, Json>,
  ctx: RunCtx,
  forceFail = false,
): Promise<AgentResult> {
  const summary = {
    "초안 등급": `${draft.grade} (${draft.decision}), 가중평균 ${draft.weighted_average}`,
    "5축 점수": Object.fromEntries(Object.entries(draft.scores as Record<string, Json>).map(([a, s]) => [a, s ? s.score : "데이터 부족"])),
    ...digest(sections),
  };
  const user =
    contextHeader(norm) +
    "\n\n[동료 분석 결과 — 이것을 공격하라]\n" +
    JSON.stringify(summary, null, 2) +
    "\n\n" +
    pool.toPromptBlock(20);
  const result = await runAgent(AGENT_ID, system(), user, ctx, {
    allowedUrls: pool.allowedUrls,
    startNote: "동료 분석 반박 중",
    forceFail,
    maxTokens: 2000,
    model: CRITIC_MODEL,
  });
  if (result.ok) ctx.emit(AGENT_ID, "done", `반론 3건 제기, 조정 제안 ${result.data.adjustments.length}건`);
  return result;
}

export interface Applied {
  axis: string;
  from: number;
  to: number;
  reason: string;
  evidence_url: string;
}

/** 근거 URL이 검색 풀에 있는 조정만 반영한다. [최종 점수, 반영 내역] 반환. */
export function applyAdjustments(
  draftScores: Record<string, Json | null>,
  critique: Json | null,
  allowedUrls: Set<string>,
): [Record<string, Json | null>, Applied[]] {
  const final: Record<string, Json | null> = {};
  const applied: Applied[] = [];
  for (const [axis, s] of Object.entries(draftScores)) final[axis] = s == null ? null : { ...s, adjusted_from: null };
  if (!critique) return [final, applied];
  const allowed = new Set([...allowedUrls].map(normUrl));
  for (const adj of critique.adjustments ?? []) {
    const { axis, delta } = adj;
    const url = String(adj.evidence_url ?? "").trim();
    const target = final[axis];
    if (target == null || delta === 0) continue;
    if (!allowed.has(normUrl(url))) continue; // 근거 없는 조정은 버린다
    const before: number = target.score;
    const after = Math.max(0, before + delta);
    if (after === before) continue;
    target.adjusted_from = before;
    target.score = after;
    applied.push({ axis, from: before, to: after, reason: adj.reason, evidence_url: url });
  }
  return [final, applied];
}
