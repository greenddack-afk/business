/**
 * Synthesizer: 1차 종합(점수·등급, 코드 고정) + 비평 반영 최종 리포트.
 * 등급 산식은 content/skills/viability_rubric.md의 '종합 등급 산식'과 동일하며 LLM이 정하지 않는다.
 */
import { SYNTH_MODEL } from "@/lib/llm";
import type { SearchPool } from "@/lib/searchPool";
import { AXES, normalizeNumbers, type AgentResult, type Json } from "@/lib/schema";
import type { Applied } from "./critic";
import { COMMON_RULES, contextHeader, runAgent, type AgentStatus, type RunCtx } from "./base";

const AGENT_ID = "synthesizer";

export const WEIGHTS: Record<string, number> = { market: 0.25, competition: 0.15, execution: 0.2, profitability: 0.25, risk: 0.15 };

// [하한, 등급, 판정]
const GRADE_TABLE: [number, string, string][] = [
  [8.5, "A+", "진행"],
  [8.0, "A", "진행"],
  [7.5, "A-", "진행"],
  [7.0, "B+", "조건부 진행"],
  [6.5, "B", "조건부 진행"],
  [6.0, "B-", "조건부 진행"],
  [5.5, "C+", "소규모 검증 후 재판단"],
  [5.0, "C", "소규모 검증 후 재판단"],
  [4.5, "C-", "보류"],
];

/** [가중 평균, 부분 평가 여부]. 점수 없는 축은 빼고 남은 가중치로 다시 나눈다. */
export function weightedAverage(scores: Record<string, number | null>): [number | null, boolean] {
  const present = Object.entries(scores).filter(([, s]) => s != null) as [string, number][];
  if (!present.length) return [null, true];
  const totalW = present.reduce((s, [a]) => s + WEIGHTS[a], 0);
  const avg = present.reduce((s, [a, v]) => s + WEIGHTS[a] * v, 0) / totalW;
  return [Math.round(avg * 100) / 100, present.length < Object.keys(WEIGHTS).length];
}

export function gradeFor(avg: number | null): [string, string] {
  if (avg == null) return ["-", "평가 불가"];
  for (const [floor, grade, decision] of GRADE_TABLE) if (avg >= floor) return [grade, decision];
  return ["D", "비권장"];
}

/** 에이전트 결과(실패 시 null)에서 5축 점수 객체를 모은다. 실패한 축은 null. */
export function collectScores(market: Json | null, finance: Json | null, execution: Json | null): Record<string, Json | null> {
  const out: Record<string, Json | null> = Object.fromEntries(AXES.map((a) => [a, null]));
  const pairs: [Json | null, string[]][] = [
    [market, ["market", "competition"]],
    [finance, ["profitability"]],
    [execution, ["execution", "risk"]],
  ];
  for (const [data, axes] of pairs) if (data) for (const a of axes) out[a] = data.scores[a];
  return out;
}

const scoreValues = (scores: Record<string, Json | null>) =>
  Object.fromEntries(Object.entries(scores).map(([a, s]) => [a, s ? (s.score as number) : null]));

/** 1차 종합: 5축 점수 + 초안 등급. Critic이 이 결과를 공격한다. */
export function draft(market: Json | null, finance: Json | null, execution: Json | null): Json {
  const scores = collectScores(market, finance, execution);
  const [avg, partial] = weightedAverage(scoreValues(scores));
  const [grade, decision] = gradeFor(avg);
  return { scores, weighted_average: avg, grade, decision, partial };
}

// ---------------------------------------------------------------- 최종 종합
const TEMPLATE = `{
  "one_liner": "이 아이디어에 대한 한 줄 판정. 등급을 설명하는 문장이 아니라 '무엇이 핵심 변수인가'를 짚는 문장. 40자 내외",
  "assumptions": [{"key": "초기 자본", "value": "3,000만원", "reason": "왜 이렇게 가정했는지"}],
  "roadmap": [
    {"stage": "1단계 검증", "period": "0~4주", "actions": ["구체적 행동 2~4개"],
     "cost": {"value": 숫자, "unit": "만원", "source_url": "", "confidence": "estimated"},
     "gate_condition": "이 조건을 만족해야 다음 단계로 간다 (숫자 포함)"},
    {"stage": "2단계 최소판매", "period": "1~3개월", "actions": ["..."], "cost": {...}, "gate_condition": "..."},
    {"stage": "3단계 확장", "period": "3~12개월", "actions": ["..."], "cost": {...}, "gate_condition": "..."}
  ]
}`;

function system(grade: string, decision: string, degraded: string[]): string {
  const degradedNote = degraded.length
    ? `\n- 다음 섹션은 분석에 실패해 데이터가 없다: ${JSON.stringify(degraded)}. 없는 데이터를 지어내지 말고, 그 영역을 검증하는 행동을 로드맵 1단계에 넣어라.`
    : "";
  return `너는 투자 심사역 팀의 최종 종합 담당(Synthesizer)이다. 동료 분석과 비평가 반론을 받아 최종 판정문·가정·3단계 로드맵을 쓴다.

${COMMON_RULES}

[담당 규칙]
- 등급(${grade})과 판정(${decision})은 이미 코드가 계산했다. 바꾸려 하지 말고, one_liner가 그 등급과 모순되지 않게 쓴다.
- one_liner는 응원도 위로도 아니다. 이 사업의 성패를 가르는 단일 변수를 짚는다. (예: "시장은 있으나 차별점을 제품이 아닌 유통에서 만들어야 한다")
- assumptions는 정규화 단계의 가정에 재무 분석에서 실제로 쓴 숫자(판매가·초기자본·채널)를 반영해 3~5개로 정리한다. 리포트 최상단에 그대로 노출되므로 사용자가 "나는 이것과 다른데"라고 판단할 수 있을 만큼 구체적이어야 한다.
- roadmap은 정확히 3단계다: 검증(0~4주) → 최소판매(1~3개월) → 확장(3~12개월).
  각 단계의 actions는 이 아이디어에만 해당하는 구체적 행동이다. "시장 조사하기" 같은 일반론 금지.
  gate_condition은 다음 단계로 넘어갈 수 있는 **측정 가능한 조건**이다(숫자 포함).
  cost는 그 단계에서 쓰는 비용이며 단위는 "만원"이다.
- 비평가 반론에서 제기된 리스크는 로드맵 1~2단계에서 검증되도록 배치한다.${degradedNote}

[출력 스키마 — 이 구조 그대로]
${TEMPLATE}`;
}

/** 최종 리포트 JSON을 만든다. LLM 실패 시에도 로드맵만 비운 리포트를 돌려준다(전체 중단 금지). */
export async function finalize(args: {
  idea: string;
  norm: Json;
  pool: SearchPool;
  sections: Record<string, Json | null>;
  finalScores: Record<string, Json | null>;
  applied: Applied[];
  critique: Json | null;
  degraded: string[];
  ctx: RunCtx;
  forceFail?: boolean;
}): Promise<[Json, AgentResult]> {
  const { idea, norm, pool, sections, finalScores, applied, critique, degraded, ctx, forceFail = false } = args;
  const [avg, partial] = weightedAverage(scoreValues(finalScores));
  const [grade, decision] = gradeFor(avg);

  const context = {
    "최종 5축 점수(비평 반영 후)": Object.fromEntries(
      Object.entries(finalScores).map(([a, s]) => [a, s ? s.score : "데이터 부족"]),
    ),
    "반영된 조정": applied,
    "비평가 반론": critique ? critique.objections : "비평 실패",
    "시장 분석": sections.market ?? null,
    "재무 분석": sections.finance ?? null,
    "실행 분석": sections.execution ?? null,
  };
  const user =
    contextHeader(norm) +
    `\n\n[코드가 계산한 최종 등급] ${grade} · ${decision} (가중평균 ${avg})\n\n[동료 분석 종합]\n` +
    JSON.stringify(context, null, 2) +
    "\n\n" +
    pool.toPromptBlock(20);

  // 내부 스키마 이름은 synthesizer_llm이지만, 화면 상태 카드는 6종 고정이므로 synthesizer로 방출한다.
  const synthCtx: RunCtx = {
    ...ctx,
    emit: (_agentId: string, status: AgentStatus, note?: string) => ctx.emit(AGENT_ID, status, note),
  };
  const result = await runAgent("synthesizer_llm", system(grade, decision, degraded), user, synthCtx, {
    allowedUrls: pool.allowedUrls,
    startNote: "최종 판정·로드맵 작성 중",
    forceFail,
    maxTokens: 2600,
    model: SYNTH_MODEL,
  });
  const written: Json = result.ok ? result.data : {};

  let report: Json = {
    idea_raw: idea,
    normalized: Object.fromEntries(
      [
        "product",
        "target",
        "differentiator",
        "industry_code",
        "industry_confidence",
        "interpretation",
        "alternative_interpretation",
      ].map((k) => [k, norm[k]]),
    ),
    verdict: {
      grade: grade !== "-" ? grade : "D",
      decision: decision + (partial ? " (부분 평가)" : ""),
      one_liner: written.one_liner || "핵심 변수를 특정하지 못했다. 아래 축별 점수와 반론을 직접 대조해 판단하라.",
    },
    assumptions: written.assumptions?.length ? written.assumptions : (norm.assumptions ?? []),
    scores: finalScores,
    market: sections.market ?? null,
    roi: sections.finance ?? null,
    feasibility: sections.execution ?? null,
    critique,
    roadmap: written.roadmap?.length ? written.roadmap : [],
    sources: buildSources(pool, { ...sections, critic: critique }),
    degraded_sections: [...degraded],
    meta: {
      weighted_average: avg,
      partial,
      applied_adjustments: applied,
      queries_run: pool.queriesRun,
    },
  };
  if (!report.roadmap.length) report.degraded_sections.push("roadmap");
  report = normalizeNumbers(report, pool.allowedUrls);
  ctx.emit(AGENT_ID, result.ok ? "done" : "failed", `최종 등급 ${report.verdict.grade}`);
  return [report, result];
}

const SECTION_LABEL: Record<string, string> = { market: "시장", finance: "ROI", execution: "실행가능성", critic: "비평" };

/** 리포트에서 실제로 인용된 URL만 출처 목록에 올린다. */
function buildSources(pool: SearchPool, sections: Record<string, Json | null>): Json[] {
  const used = new Map<string, Set<string>>();
  for (const [name, data] of Object.entries(sections)) {
    for (const url of walkUrls(data)) {
      const label = SECTION_LABEL[name] ?? name;
      if (!used.has(url)) used.set(url, new Set());
      used.get(url)!.add(label);
    }
  }
  const out: Json[] = [];
  for (const r of pool.asList()) {
    const tags = used.get(r.url);
    if (tags) out.push({ title: r.title, url: r.url, used_for: [...tags].sort().join(" · ") });
  }
  return out;
}

function walkUrls(node: Json): string[] {
  if (Array.isArray(node)) return node.flatMap(walkUrls);
  if (node && typeof node === "object") {
    const urls: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (["source_url", "url", "evidence_url"].includes(k) && typeof v === "string" && v.trim()) urls.push(v.trim());
      else urls.push(...walkUrls(v));
    }
    return urls;
  }
  return [];
}
