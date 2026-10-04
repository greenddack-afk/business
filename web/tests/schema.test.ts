import { describe, expect, it } from "vitest";
import params from "@/content/industry_params.json";
import { SKILLS } from "@/lib/generated/skills";
import { AGENT_IDS, AXES, extractJson, INDUSTRY_CODES, normalizeNumbers, runWithRetry, SCHEMAS, validate } from "@/lib/schema";
import { ASSUMPTION, clone, CRITIC, MARKET, N, REPORT, VALID } from "./fixtures";

describe("유효 샘플", () => {
  it.each(Object.entries(VALID))("%s 통과", (agentId, sample) => {
    expect(validate(agentId, sample)).toEqual([]);
  });
  it("에이전트 6종 모두 스키마가 있다", () => {
    for (const a of AGENT_IDS) expect(SCHEMAS[a]).toBeTruthy();
  });
});

describe("무효 샘플", () => {
  it("필드 누락", () => {
    const bad = clone(MARKET);
    delete bad.size;
    expect(validate("market", bad).some((e) => e.includes("size"))).toBe(true);
  });
  it("점수 범위 초과", () => {
    const bad = clone(MARKET);
    bad.scores.market.score = 11;
    expect(validate("market", bad).length).toBeGreaterThan(0);
  });
  it("비평 delta -3 / +1 거부", () => {
    for (const d of [-3, 1]) {
      const bad = clone(CRITIC);
      bad.adjustments[0].delta = d;
      expect(validate("critic", bad).length).toBeGreaterThan(0);
    }
  });
  it("반론 각도 3종이 서로 달라야 한다", () => {
    const bad = clone(CRITIC);
    bad.objections[1].angle = bad.objections[0].angle;
    expect(validate("critic", bad).length).toBeGreaterThan(0);
  });
  it("비운 섹션은 degraded_sections에 있어야 한다", () => {
    const bad = clone(REPORT);
    bad.roi = null;
    expect(validate("synthesizer", bad).length).toBeGreaterThan(0);
    bad.degraded_sections = ["roi"];
    expect(validate("synthesizer", bad)).toEqual([]);
  });
  it("객체가 아니면 실패", () => {
    expect(validate("market", ["x"]).length).toBeGreaterThan(0);
  });
});

describe("숫자 정규화", () => {
  it("빈 출처는 estimated", () => {
    expect(normalizeNumbers({ a: N(1, "억원", "", "sourced") }).a.confidence).toBe("estimated");
  });
  it("null 출처는 빈 문자열 + estimated", () => {
    const out = normalizeNumbers({ a: { value: 1, unit: "개", source_url: null, confidence: "sourced" } });
    expect(out.a.source_url).toBe("");
    expect(out.a.confidence).toBe("estimated");
  });
  it("검색 풀에 없는 URL은 떼어 낸다", () => {
    const out = normalizeNumbers({ a: N(1, "개", "https://fake.example/x") }, ["https://real.com/1"]);
    expect(out.a.source_url).toBe("");
    expect(out.a.confidence).toBe("estimated");
  });
  it("끝 슬래시 차이는 같은 URL로 본다", () => {
    expect(normalizeNumbers({ a: N(1, "개", "https://real.com/1/") }, ["https://real.com/1"]).a.confidence).toBe("sourced");
  });
  it("문자열 숫자 변환", () => {
    expect(normalizeNumbers({ a: { value: "3,200", unit: "억원", source_url: "", confidence: "estimated" } }).a.value).toBe(3200);
  });
  it("가정 객체는 숫자로 보지 않는다", () => {
    expect(normalizeNumbers({ assumptions: [ASSUMPTION] }).assumptions[0]).not.toHaveProperty("confidence");
  });
  it("원본을 바꾸지 않는다", () => {
    const original = { a: N(1, "개", "", "sourced") };
    normalizeNumbers(original);
    expect(original.a.confidence).toBe("sourced");
  });
});

describe("JSON 추출", () => {
  it("그대로", () => expect(extractJson('{"a": 1}')).toEqual({ a: 1 }));
  it("마크다운 펜스", () => expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 }));
  it("앞뒤 잡담", () => expect(extractJson('결과입니다:\n{"a": {"b": 2}}\n끝')).toEqual({ a: { b: 2 } }));
  it("쓰레기 입력은 예외", () => expect(() => extractJson("JSON 없음")).toThrow());
});

describe("재시도", () => {
  it("첫 시도 성공", async () => {
    const calls: (string | null)[] = [];
    const res = await runWithRetry("critic", async (fb) => {
      calls.push(fb);
      return JSON.stringify(CRITIC);
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(1);
    expect(calls).toEqual([null]);
  });
  it("한 번 실패 후 성공, 피드백 전달", async () => {
    const outputs = ["깨진 응답", "```json\n" + JSON.stringify(CRITIC) + "\n```"];
    const feedbacks: (string | null)[] = [];
    const res = await runWithRetry("critic", async (fb) => {
      feedbacks.push(fb);
      return outputs.shift()!;
    });
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(2);
    expect(feedbacks[0]).toBeNull();
    expect(feedbacks[1]).toContain("거부");
  });
  it("두 번 실패해도 예외 없이 ok=false", async () => {
    const res = await runWithRetry("finance", async () => {
      throw new Error("API 다운");
    });
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(2);
    expect(res.data).toBeNull();
    expect(res.errors[0]).toContain("API 다운");
  });
  it("스키마 위반 두 번이면 실패", async () => {
    const res = await runWithRetry("critic", async () => JSON.stringify({ objections: [], adjustments: [] }));
    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(2);
  });
  it("검증 전에 정규화한다", async () => {
    const sample = clone(MARKET);
    sample.size = N(3200, "억원", "https://made-up.example/x");
    const res = await runWithRetry("market", async () => JSON.stringify(sample), { allowedUrls: ["https://real.com"] });
    expect(res.ok).toBe(true);
    expect(res.data.size.confidence).toBe("estimated");
  });
});

describe("프로젝트 파일", () => {
  it("업종 8개가 스키마와 같다", () => {
    const industries = params.industries as Record<string, { refined?: boolean }>;
    expect(new Set(Object.keys(industries))).toEqual(new Set(INDUSTRY_CODES));
    const refined = Object.entries(industries)
      .filter(([, v]) => v.refined)
      .map(([k]) => k)
      .sort();
    expect(refined).toEqual(["commerce", "manufacturing"]);
    expect(params.scenario_model.ramp).toHaveLength(12);
  });
  it("루브릭에 5축이 모두 있다", () => {
    for (const axis of AXES) expect(SKILLS.viability_rubric).toContain(`### ${axis} `);
  });
  it("ROI 스킬이 있다", () => {
    expect(SKILLS.roi_simulator.trim().length).toBeGreaterThan(0);
  });
});
