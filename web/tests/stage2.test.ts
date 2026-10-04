import { describe, expect, it, vi } from "vitest";
import { dedupeNormalizerQueries, EXAMPLE_IDEAS, validateIdea } from "@/lib/agents/normalizer";
import { dedupeQueries, MAX_QUERIES, SearchPool } from "@/lib/searchPool";

describe("입력 검증", () => {
  it("빈 입력 거부", () => {
    for (const t of ["", "   ", null]) expect(validateIdea(t)[0]).toBe(false);
  });
  it("자모·기호·숫자만 있는 입력 거부", () => {
    for (const t of ["ㅁㄴㅇㄹ", "ㅋㅋㅋㅋ", "!!!???", "12345", "ㅁㄴㅇㄹ ㅂㅈㄷㄱ"]) expect(validateIdea(t)[0]).toBe(false);
  });
  it("같은 글자 반복 거부", () => expect(validateIdea("아아아아아아")[0]).toBe(false));
  it("너무 긴 입력 거부", () => expect(validateIdea("가나다라".repeat(30))[0]).toBe(false));
  it("실제 아이디어는 통과", () => {
    for (const t of ["따뜻한 폼롤러", "AI 필라테스 코치 앱", "반려견 수제간식 정기배송"]) expect(validateIdea(t)[0]).toBe(true);
  });
  it("예시 3개는 유효", () => {
    expect(EXAMPLE_IDEAS).toHaveLength(3);
    for (const t of EXAMPLE_IDEAS) expect(validateIdea(t)[0]).toBe(true);
  });
});

describe("쿼리 중복 제거", () => {
  it("어순·구두점만 다른 쿼리 제거", () => {
    expect(dedupeQueries(["폼롤러 시장 규모", "폼롤러  시장 규모!", "시장 규모 폼롤러", "KC 인증 비용"])).toEqual([
      "폼롤러 시장 규모",
      "KC 인증 비용",
    ]);
  });
  it("상한 적용", () => {
    const qs = Array.from({ length: 15 }, (_, i) => `완전히 다른 검색어${String.fromCharCode(0xac00 + i * 50)}${i}`);
    expect(dedupeQueries(qs)).toHaveLength(MAX_QUERIES);
    expect(MAX_QUERIES).toBeLessThanOrEqual(9);
  });
  it("정규화 단계 중복 제거", () => {
    expect(dedupeNormalizerQueries(["A 검색", "a검색", "B 검색"])).toEqual(["A 검색", "B 검색"]);
  });
});

describe("검색 풀", () => {
  it("같은 쿼리는 두 번 검색하지 않는다", async () => {
    const pool = new SearchPool();
    const calls: string[] = [];
    vi.spyOn(pool, "searchOne").mockImplementation(async (q) => {
      calls.push(q);
    });
    await pool.collect(["폼롤러 시장", "KC 인증 비용"]);
    await pool.collect(["폼롤러 시장", "새 검색어 추가"]);
    expect([...calls].sort()).toEqual(["KC 인증 비용", "새 검색어 추가", "폼롤러 시장"].sort());
  });
  it("실패한 쿼리는 기록하고 나머지는 계속", async () => {
    const pool = new SearchPool();
    vi.spyOn(pool, "searchOne").mockImplementation(async (q) => {
      if (q.includes("실패")) throw new Error("boom");
    });
    await pool.collect(["실패할 검색", "정상 검색어"]);
    expect(pool.failedQueries.map((f) => f.query)).toEqual(["실패할 검색"]);
  });
});
