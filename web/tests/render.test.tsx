import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReportView from "@/components/Report";
import { REPORT } from "./fixtures";

const load = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("리포트 화면", () => {
  it.each([
    ["샘플 리포트", load("../public/sample_report.json")],
    ["실제 분석 결과", load("./live_report.json")],
  ])("%s를 오류 없이 그린다", (_name, report) => {
    const html = renderToString(<ReportView report={report} onNew={() => {}} />);
    expect(html).toContain(report.idea_raw);
    expect(html).toContain(report.verdict.one_liner);
    for (const id of ["sec-summary", "sec-scores", "sec-market", "sec-roi", "sec-feas", "sec-critic", "sec-road"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it("빠진 섹션은 '데이터 부족'으로 표시한다", () => {
    const r = structuredClone(REPORT);
    r.meta = { weighted_average: 5, applied_adjustments: [], queries_run: [] };
    r.roi = null;
    r.degraded_sections = ["roi"];
    const html = renderToString(<ReportView report={r} onNew={() => {}} />);
    expect(html).toContain("ROI<!-- --> 항목은 분석에서 제외됐어요");
  });
});
