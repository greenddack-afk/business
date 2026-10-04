import { afterEach, describe, expect, it, vi } from "vitest";

// API 호출 없이 실패 경로를 시험한다: 모든 LLM 호출이 결제 오류로 실패하는 상황.
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  callLlm: vi.fn(async () => {
    throw new Error("BadRequestError: credit balance is too low");
  }),
}));

import { noopEmit } from "@/lib/agents/base";
import { applyAdjustments } from "@/lib/agents/critic";
import { recompute } from "@/lib/agents/finance";
import { draft, gradeFor, weightedAverage } from "@/lib/agents/synthesizer";
import { PipelineAbort, prepare, runPipeline, steps, USER_FACING_ERROR } from "@/lib/pipeline";
import type { AgentResult } from "@/lib/schema";
import { SearchPool } from "@/lib/searchPool";
import { clone, FINANCE, MARKET } from "./fixtures";

const ctx = { emit: noopEmit };
const failed = (agentId: string): AgentResult => ({
  agentId,
  ok: false,
  data: null,
  errors: ["BadRequestError: credit balance is too low"],
  attempts: 2,
  raw: "",
  history: [],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("오류 처리", () => {
  it("전문가 3명이 모두 실패하면 친절한 문구로 중단", async () => {
    vi.spyOn(steps, "prepare").mockResolvedValue([{ industry_code: "manufacturing" }, new SearchPool()]);
    vi.spyOn(steps, "runSpecialists").mockResolvedValue({
      market: failed("market"),
      finance: failed("finance"),
      execution: failed("execution"),
    });
    const err = await runPipeline("따뜻한 폼롤러", ctx).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineAbort);
    expect(err.message).toBe(USER_FACING_ERROR);
    expect(err.message.toLowerCase()).not.toContain("credit"); // 결제·기술 원인을 소비자에게 노출하지 않는다
  });
  it("정규화 실패도 기술 원인을 숨긴다", async () => {
    const err = await prepare("따뜻한 폼롤러", ctx).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineAbort);
    expect(err.message).toBe(USER_FACING_ERROR);
  });
  it("입력 오류 문구는 구체적으로 남는다", async () => {
    const err = await prepare("ㅁㄴㅇㄹ", ctx).catch((e) => e);
    expect(err).toBeInstanceOf(PipelineAbort);
    expect(err.message).not.toBe(USER_FACING_ERROR);
  });
});

describe("코드 계산", () => {
  it("재무 재계산: 기여이익·BEP·투자 합계", () => {
    const d = recompute(clone(FINANCE));
    expect(d.unit_economics.contribution_margin.value).toBe(34000); // 69000 - 23000 - 12000
    expect(d.break_even.units_per_month.value).toBe(Math.ceil((300 * 10000) / 34000)); // 89
    expect(d.total_initial_investment.value).toBe(1200);
    expect(d.scenarios.base.monthly_units.value).toBe(200);
    expect(d.summary.startsWith("손익분기는 월 89개")).toBe(true);
  });
  it("가중 평균·등급", () => {
    expect(weightedAverage({ market: 8, competition: 8, execution: 8, profitability: 8, risk: 8 })).toEqual([8, false]);
    expect(weightedAverage({ market: 8, competition: null, execution: null, profitability: null, risk: null })).toEqual([8, true]);
    expect(gradeFor(8.5)).toEqual(["A+", "진행"]);
    expect(gradeFor(4.4)).toEqual(["D", "비권장"]);
    expect(gradeFor(null)).toEqual(["-", "평가 불가"]);
  });
  it("비평 조정은 검색 풀에 있는 근거 URL일 때만 반영", () => {
    const d = draft(clone(MARKET), null, null);
    const critique = {
      adjustments: [
        { axis: "market", delta: -1, reason: "r", evidence_url: "https://real.com/1/" },
        { axis: "competition", delta: -2, reason: "r", evidence_url: "https://fake.example" },
      ],
    };
    const [final, applied] = applyAdjustments(d.scores, critique, new Set(["https://real.com/1"]));
    expect(final.market!.score).toBe(6);
    expect(final.market!.adjusted_from).toBe(7);
    expect(final.competition!.score).toBe(3);
    expect(applied).toHaveLength(1);
  });
});
