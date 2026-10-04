/** Market: 시장 규모·성장률·경쟁사·트렌드 + 시장성/경쟁 점수. 공용 검색 풀 결과를 읽는다(직접 검색하지 않음). */
import type { SearchPool } from "@/lib/searchPool";
import type { AgentResult, Json } from "@/lib/schema";
import { COMMON_RULES, contextHeader, rubricBlock, runAgent, type RunCtx } from "./base";

const AGENT_ID = "market";

const TEMPLATE = `{
  "scores": {
    "market":      {"rubric_ref": "market:7-8", "score": 7, "rationale": "결론 문장 + 근거"},
    "competition": {"rubric_ref": "competition:3-4", "score": 3, "rationale": "..."}
  },
  "summary": "결론 문장으로 시작하는 시장 요약 2~3문장",
  "size":   {"value": 숫자, "unit": "억원/년 등", "source_url": "", "confidence": "estimated"},
  "growth": {"value": 숫자, "unit": "%/년", "source_url": "", "confidence": "estimated"},
  "competition_level": "상|중|하   (상 = 경쟁 강함)",
  "competitors": [{"name": "브랜드/제품명", "positioning": "가격대·특징", "url": "출처 후보 URL 또는 빈 문자열", "note": "차별점과의 관계"}],
  "trends": ["트렌드 1줄", "트렌드 1줄", "트렌드 1줄"]
}`;

const system = () => `너는 투자 심사역 팀의 시장 분석 담당(Market)이다. 아래 검색 자료만을 근거로 시장 규모, 성장률, 경쟁 구도, 트렌드를 정리하고 시장성·경쟁 2개 축을 채점한다.

${COMMON_RULES}

[담당 규칙]
- size: 한국 시장 규모를 우선한다. 한국 수치가 없고 글로벌 수치만 있으면 글로벌 수치를 쓰되 unit에 "글로벌 억달러/년"처럼 범위를 명시한다.
- competitors는 최대 6개. 검색 결과에서 실제로 확인되는 경쟁 제품·브랜드만 쓴다. 지어내지 마라. 확인된 게 3개 미만이면 있는 만큼만 쓴다.
- competition_level은 경쟁이 강할수록 "상". 경쟁 축 점수는 반대로 경쟁이 약할수록 높다(루브릭 참조).
- 이 아이디어의 차별점이 시장에 이미 존재하는지 검색 결과로 확인해 competition 채점과 summary에 반영한다.
- trends는 정확히 3줄, 각 1문장.
- 시장성·경쟁 축은 검색으로 확인된 근거 URL이 없으면 최대 6점이다.

${rubricBlock()}

[출력 스키마 — 이 구조 그대로]
${TEMPLATE}`;

/** 루브릭 공통 규칙 4: 근거 URL이 없는 축은 최대 6점. 코드로 강제한다. */
export function capWithoutEvidence(data: Json, pool: SearchPool): void {
  const scores = data.scores;
  const allowed = pool.allowedUrls;
  const marketSourced = Boolean(data.size.source_url || data.growth.source_url);
  const compSourced = (data.competitors as Json[]).some((c) => allowed.has(c.url));
  for (const [axis, hasEvidence] of [
    ["market", marketSourced],
    ["competition", compSourced],
  ] as const) {
    if (scores[axis].score > 6 && !hasEvidence) {
      scores[axis].score = 6;
      scores[axis].rubric_ref = `${axis}:5-6`;
      scores[axis].rationale += " (근거 URL이 없어 상한 6점 적용)";
    }
  }
}

export async function run(norm: Json, pool: SearchPool, ctx: RunCtx, forceFail = false): Promise<AgentResult> {
  const user = contextHeader(norm) + "\n\n" + pool.toPromptBlock();
  const result = await runAgent(AGENT_ID, system(), user, ctx, {
    allowedUrls: pool.allowedUrls,
    startNote: "수집 자료 분석 중",
    forceFail,
  });
  if (result.ok) {
    capWithoutEvidence(result.data, pool);
    ctx.emit(AGENT_ID, "done", `경쟁사 ${result.data.competitors.length}곳 확인`);
  }
  return result;
}
