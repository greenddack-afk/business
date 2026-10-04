/**
 * 오케스트레이터: 순서 제어 · 병렬 실행 · 스키마 검증 · 부분 실패 허용.
 * 데이터 흐름: 정규화 → 공용 검색 → (시장·재무·실행 병렬) → 1차 종합 → 비평 1회 → 최종 종합.
 */
import * as critic from "./agents/critic";
import * as execution from "./agents/execution";
import * as finance from "./agents/finance";
import * as market from "./agents/market";
import * as normalizer from "./agents/normalizer";
import * as synthesizer from "./agents/synthesizer";
import type { RunCtx } from "./agents/base";
import { validate, type AgentResult, type Json } from "./schema";
import { SearchPool } from "./searchPool";

export const USER_FACING_ERROR = "분석 서비스에 일시적인 문제가 있어 결과를 만들지 못했어요. 잠시 후 다시 시도해 주세요.";

/** 정규화 실패·입력 무효처럼 더 진행할 수 없을 때만 사용한다(개별 에이전트 실패는 여기 해당하지 않음). */
export class PipelineAbort extends Error {
  name = "PipelineAbort";
}

export async function prepare(idea: string, ctx: RunCtx): Promise<[Json, SearchPool]> {
  const [ok, reason] = normalizer.validateIdea(idea);
  if (!ok) throw new PipelineAbort(reason);
  const norm = await normalizer.run(idea, ctx);
  if (!norm.ok) {
    console.error("normalizer failed:", norm.errors.slice(0, 3)); // 기술 원인은 서버 로그에만 남긴다
    throw new PipelineAbort(USER_FACING_ERROR);
  }
  const pool = await new SearchPool(ctx.signal).collect(norm.data.queries, ctx.emit, "market");
  return [norm.data, pool];
}

/** 시장·재무·실행을 병렬 실행. 하나가 실패해도 나머지는 계속된다. */
export async function runSpecialists(
  norm: Json,
  pool: SearchPool,
  ctx: RunCtx,
  fail: Set<string>,
): Promise<Record<string, AgentResult>> {
  const [m, f, e] = await Promise.all([
    market.run(norm, pool, ctx, fail.has("market")),
    finance.run(norm, pool, ctx, fail.has("finance")),
    execution.run(norm, pool, ctx, fail.has("execution")),
  ]);
  return { market: m, finance: f, execution: e };
}

const SECTION_OF: Record<string, string> = { market: "market", finance: "roi", execution: "feasibility", critic: "critique" };

// 테스트에서 단계별로 갈아끼울 수 있게 묶어 둔다.
export const steps = { prepare, runSpecialists };

/** 한 줄 아이디어 → 최종 리포트. 개별 에이전트가 실패해도 그 섹션만 비우고 끝까지 간다. */
export async function runPipeline(idea: string, ctx: RunCtx, failAgents: Iterable<string> = []) {
  const fail = new Set(failAgents);
  const [normalized, pool] = await steps.prepare(idea, ctx);

  const results = await steps.runSpecialists(normalized, pool, ctx, fail);
  if (!["market", "finance", "execution"].some((a) => results[a].ok)) {
    // 3명이 모두 실패하면 남는 게 없다. 빈 D등급 리포트는 진짜 평가로 오해되므로 오류로 끝낸다.
    for (const [a, r] of Object.entries(results)) console.error(`${a} failed:`, r.errors.slice(0, 2));
    throw new PipelineAbort(USER_FACING_ERROR);
  }
  const sections: Record<string, Json | null> = Object.fromEntries(
    Object.entries(results).map(([a, r]) => [a, r.ok ? r.data : null]),
  );
  const draft = synthesizer.draft(sections.market, sections.finance, sections.execution);

  const crit = await critic.run(normalized, pool, draft, sections, ctx, fail.has("critic"));
  results.critic = crit;
  const critique = crit.ok ? crit.data : null;
  const [finalScores, applied] = critic.applyAdjustments(draft.scores, critique, pool.allowedUrls);

  const degraded = ["market", "finance", "execution", "critic"].filter((a) => !results[a].ok).map((a) => SECTION_OF[a]);
  const [report, synth] = await synthesizer.finalize({
    idea,
    norm: normalized,
    pool,
    sections,
    finalScores,
    applied,
    critique,
    degraded,
    ctx,
    forceFail: fail.has("synthesizer"),
  });
  results.synthesizer = synth;

  const errors = validate("synthesizer", report);
  report.meta.schema_errors = errors; // 비어 있어야 정상
  report.meta.draft_grade = draft.grade;
  report.meta.search = { urls: pool.results.size, failed_queries: pool.failedQueries };
  for (const [a, r] of Object.entries(results)) {
    if (!r.ok) console.error(`${a} 실패(${r.attempts}회 시도):`, r.errors.slice(0, 2));
  }
  return { report, results, pool, draft, schemaErrors: errors };
}
