"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { ExtLink, fmt, Num, safeUrl, type Report } from "./format";
import Radar, { AX } from "./Radar";

export const NAV: [string, string][] = [
  ["sec-summary", "요점"],
  ["sec-scores", "사업성"],
  ["sec-market", "시장"],
  ["sec-roi", "ROI"],
  ["sec-feas", "실행"],
  ["sec-critic", "반론"],
  ["sec-road", "로드맵"],
];

const GRADE_LEGEND: [string, string][] = [
  ["A", "진행"],
  ["B", "조건부 진행"],
  ["C", "소규모 검증 후 재판단"],
  ["C-", "보류"],
  ["D", "비권장"],
];
const gradeKey = (g: string) => (g === "C-" ? "C-" : g[0]);

function Head({ ico, title, by }: { ico: string; title: string; by?: string }) {
  return (
    <div className="sec-head">
      <div className="ico" aria-hidden="true">
        {ico}
      </div>
      <h2>{title}</h2>
      {by ? <div className="by">작성 · {by}</div> : null}
    </div>
  );
}

function Degraded({ what }: { what: string }) {
  return (
    <div className="degraded">
      <b>데이터 부족</b> — {what} 항목은 분석에서 제외됐어요.
      <br />
      나머지 섹션은 정상 분석 결과예요.
    </div>
  );
}

function SampleBanner({ r, onNew }: { r: Report; onNew: () => void }) {
  return (
    <div className="sample-banner">
      <b>샘플 리포트</b>
      <span>“{r.idea_raw}”를 실제로 분석한 결과 예시예요. 내 아이디어는 다르게 나옵니다.</span>
      <span className="sp" />
      <button className="btn sm" onClick={onNew}>
        내 아이디어 분석하기
      </button>
    </div>
  );
}

function Hero({ r }: { r: Report }) {
  const v = r.verdict;
  const n = r.normalized;
  const gk = gradeKey(v.grade);
  const on = GRADE_LEGEND.find(([k]) => k === gk) ? gk : "";
  return (
    <div className="hero">
      <div className="eyebrow">분석 리포트</div>
      <h1 className="idea">{r.idea_raw}</h1>
      <div className="prod">{n.product}</div>
      <div className="verdict">
        <div className="grade" aria-label={`종합 등급 ${v.grade}`}>
          {v.grade}
        </div>
        <div>
          <div className="dec">{v.decision}</div>
          <div className="one">{v.one_liner}</div>
        </div>
      </div>
      <div className="legend" aria-label="등급 읽는 법">
        <span>등급 읽는 법</span>
        {GRADE_LEGEND.map(([k, t]) => (
          <span key={k} className={`lg ${k === on ? "on" : ""}`}>
            {k} {t}
          </span>
        ))}
      </div>
      <div className="assume">
        <b className="h">이 분석이 서 있는 가정</b>
        <div className="s">내 상황과 다르면 결과도 달라져요. 가정을 먼저 확인해 보세요.</div>
        <ul>
          {(r.assumptions || []).map((a: Report, i: number) => (
            <li key={i}>
              <b>{a.key}</b> — {a.value}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Facts({ r }: { r: Report }) {
  const o = r.roi;
  const na = <span className="est">데이터 부족</span>;
  const be = o ? o.break_even.units_per_month : null;
  const base = o ? o.scenarios.base.cumulative_profit_12m : null;
  return (
    <div className="facts">
      <div className="fact">
        <div className="k">손익분기 (이만큼 팔아야 본전)</div>
        <div className="v mono">{be ? (be.value > 0 ? `월 ${fmt(be.value)}개` : "도달 불가") : na}</div>
        <div className="n">월 고정비 ÷ 개당 기여이익</div>
      </div>
      <div className="fact">
        <div className="k">총 초기 투자</div>
        <div className="v mono">{o ? <Num n={o.total_initial_investment} /> : na}</div>
        <div className="n">{o ? `${o.initial_investment.length}개 항목 합계` : ""}</div>
      </div>
      <div className="fact">
        <div className="k">12개월 누적 손익 (기본 시나리오)</div>
        <div className="v mono">{base ? <Num n={base} sign /> : na}</div>
        <div className="n">초기투자 포함, 세전</div>
      </div>
    </div>
  );
}

function SecSummary({ r }: { r: Report }) {
  const n = r.normalized;
  return (
    <section className="sec" id="sec-summary">
      <Head ico="🔍" title="아이디어 요점" by="해석가" />
      <div className="grid3">
        <div className="tile">
          <div className="k">제품</div>
          <div className="v">{n.product}</div>
        </div>
        <div className="tile">
          <div className="k">타깃</div>
          <div className="v">{n.target}</div>
        </div>
        <div className="tile">
          <div className="k">차별점</div>
          <div className="v">{n.differentiator}</div>
        </div>
      </div>
      {n.alternative_interpretation ? (
        <p className="alt">
          다른 해석: {n.alternative_interpretation} (업종 분류 확신도 {Math.round(n.industry_confidence * 100)}%)
        </p>
      ) : null}
    </section>
  );
}

function Axis({ label, s }: { label: string; s: Report }) {
  const [open, setOpen] = useState(false);
  if (!s) {
    return (
      <div className="axis" style={{ cursor: "default" }}>
        <div className="top">
          <div className="nm">{label}</div>
          <div className="trk" />
          <div className="val est">—</div>
          <div className="adj" />
        </div>
        <div className="hint">데이터 부족 — 분석에서 제외됐어요</div>
      </div>
    );
  }
  const adjusted = s.adjusted_from != null;
  return (
    <button className="axis" aria-expanded={open} aria-label={`${label} ${s.score}점, 근거 펼치기`} onClick={() => setOpen(!open)}>
      <div className="top">
        <div className="nm">{label}</div>
        <div className="trk">
          <i style={{ width: `${s.score * 10}%` }} />
        </div>
        <div className="val mono">
          {s.score}
          <span style={{ color: "var(--muted)", fontWeight: 500 }}>/10</span>
        </div>
        <div className="adj" title="비평 반영으로 조정됨">
          {adjusted ? `${s.adjusted_from}→${s.score}` : ""}
        </div>
      </div>
      <div className="hint">근거 보기 ▾</div>
      <div className="why">
        {s.rationale}
        <small>
          채점 구간 {s.rubric_ref}
          {adjusted ? ` · 비평 반영 ${s.adjusted_from}→${s.score}` : ""}
        </small>
      </div>
    </button>
  );
}

function SecScores({ r }: { r: Report }) {
  const anyAdj = AX.some(([k]) => r.scores[k] && r.scores[k].adjusted_from != null);
  return (
    <section className="sec" id="sec-scores">
      <Head ico="⚖️" title="사업성 평가" by="심사위원" />
      <p className="concl">
        5개 축의 가중 평균은 <b>{r.meta.weighted_average ?? "—"}</b>점이고, 종합 등급은 <b>{r.verdict.grade}</b>이다. 축을 누르면 채점 근거가 펼쳐진다.
      </p>
      <div className="scores">
        <div>
          <div className="radar-box">
            <Radar report={r} />
          </div>
          <div className="rl">
            <span>
              <i />
              최종 점수
            </span>
            {anyAdj ? (
              <span>
                <i className="dash" />
                비평 반영 전
              </span>
            ) : null}
          </div>
        </div>
        <div>
          {AX.map(([k, label]) => (
            <Axis key={k} label={label} s={r.scores[k]} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SecMarket({ r, dg }: { r: Report; dg: string[] }) {
  const h = <Head ico="🔭" title="시장 배경지식" by="정찰병" />;
  if (dg.includes("market") || !r.market) {
    return (
      <section className="sec" id="sec-market">
        {h}
        <Degraded what="시장" />
      </section>
    );
  }
  const m = r.market;
  const lvTxt = ({ 상: "강함", 중: "보통", 하: "약함" } as Record<string, string>)[m.competition_level] || m.competition_level;
  const comps: Report[] = m.competitors || [];
  return (
    <section className="sec" id="sec-market">
      {h}
      <p className="concl">{m.summary}</p>
      <div className="grid3">
        <div className="tile kpi">
          <div className="k">시장 규모</div>
          <div className="v">
            <Num n={m.size} />
          </div>
        </div>
        <div className="tile kpi">
          <div className="k">성장률</div>
          <div className="v">
            <Num n={m.growth} />
          </div>
        </div>
        <div className="tile kpi">
          <div className="k">경쟁 강도</div>
          <div className="v">{lvTxt}</div>
        </div>
      </div>
      {comps.length ? (
        <div className="tscroll" style={{ marginTop: 20 }}>
          <table>
            <thead>
              <tr>
                <th>주요 경쟁사</th>
                <th>포지셔닝</th>
                <th>차별점과의 관계</th>
              </tr>
            </thead>
            <tbody>
              {comps.map((c, i) => {
                const u = safeUrl(c.url);
                return (
                  <tr key={i}>
                    <td>
                      <b>{c.name}</b>
                      {u ? (
                        <ExtLink className="src" href={u}>
                          링크
                        </ExtLink>
                      ) : null}
                    </td>
                    <td>{c.positioning}</td>
                    <td>{c.note || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <ul style={{ margin: "18px 0 0", paddingLeft: 18 }}>
        {(m.trends || []).map((t: string, i: number) => (
          <li key={i} style={{ margin: "5px 0" }}>
            {t}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ScenarioBars({ sc }: { sc: Report }) {
  const keys: [string, string][] = [
    ["conservative", "보수"],
    ["base", "기본"],
    ["optimistic", "낙관"],
  ];
  const vals: number[] = keys.map(([k]) => sc[k].cumulative_profit_12m.value);
  const negs = vals.filter((v) => v < 0).map((v) => -v);
  const poss = vals.filter((v) => v > 0);
  const negSpan = negs.length ? Math.max(...negs) : 0;
  const posSpan = poss.length ? Math.max(...poss) : 0;
  const total = negSpan + posSpan || 1;
  const zero = (negSpan / total) * 100;
  return (
    <>
      <div className="scen">
        {keys.map(([k, l], i) => {
          const v = vals[i];
          const pct = (Math.abs(v) / total) * 100;
          return (
            <div className="row" key={k}>
              <div className="lb">
                {l}
                <small>월 {fmt(sc[k].monthly_units.value)}개</small>
              </div>
              <div className="dv" style={{ "--zero": `${zero}%` } as CSSProperties}>
                {v >= 0 ? (
                  <i className="pos" style={{ width: `${pct}%` }} />
                ) : (
                  <i className="neg" style={{ left: `${zero - pct}%`, width: `${pct}%` }} />
                )}
              </div>
              <div className={`amt mono ${v < 0 ? "neg" : ""}`}>
                <Num n={sc[k].cumulative_profit_12m} sign />
              </div>
            </div>
          );
        })}
      </div>
      <div className="scen-note">막대 기준선 왼쪽은 손실, 오른쪽은 이익이에요. 초기 투자를 포함한 12개월 누적 손익(세전)이에요.</div>
    </>
  );
}

function SecRoi({ r, dg }: { r: Report; dg: string[] }) {
  const h = <Head ico="🧮" title="ROI 시뮬레이션" by="회계사" />;
  if (dg.includes("roi") || !r.roi) {
    return (
      <section className="sec" id="sec-roi">
        {h}
        <Degraded what="ROI" />
      </section>
    );
  }
  const o = r.roi;
  const ue = o.unit_economics;
  const be = o.break_even;
  const bepTxt = be.units_per_month.value > 0 ? `월 ${fmt(be.units_per_month.value)}개` : "도달 불가";
  return (
    <section className="sec" id="sec-roi">
      {h}
      <p className="concl">{o.summary}</p>
      <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 26 }}>
        <div className="tscroll">
          <table>
            <thead>
              <tr>
                <th>초기 투자</th>
                <th className="num">금액</th>
              </tr>
            </thead>
            <tbody>
              {o.initial_investment.map((i: Report, idx: number) => (
                <tr key={idx}>
                  <td>{i.item}</td>
                  <td className="num">
                    <Num n={i.amount} />
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td>합계</td>
                <td className="num">
                  <Num n={o.total_initial_investment} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="tscroll">
          <table>
            <thead>
              <tr>
                <th>단위 경제 (1개 팔 때)</th>
                <th className="num">금액</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>판매가</td>
                <td className="num">
                  <Num n={ue.price} />
                </td>
              </tr>
              <tr>
                <td>제품 원가</td>
                <td className="num">
                  <Num n={ue.unit_cost} />
                </td>
              </tr>
              <tr>
                <td>변동비 (수수료·배송·광고·반품)</td>
                <td className="num">
                  <Num n={ue.variable_cost} />
                </td>
              </tr>
              <tr className="total">
                <td>개당 기여이익</td>
                <td className="num">
                  <Num n={ue.contribution_margin} />
                </td>
              </tr>
              <tr>
                <td>월 고정비</td>
                <td className="num">
                  <Num n={o.fixed_cost_monthly} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="bep">
        <div className="lbl">손익분기점 — 이만큼 팔아야 본전이에요</div>
        <div className="big mono">{bepTxt}</div>
        <div className="sub">
          초기투자 회수 {be.payback_months.value > 0 ? `${fmt(be.payback_months.value)}개월` : "불가"} · 월 고정비 ÷ 개당 기여이익
        </div>
      </div>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>12개월 시나리오</h3>
      <ScenarioBars sc={o.scenarios} />
    </section>
  );
}

const LV: Record<string, [string, string]> = { 상: ["▲", "부담 큼"], 중: ["●", "보통"], 하: ["▽", "낮음"] };

function SecFeasibility({ r, dg }: { r: Report; dg: string[] }) {
  const h = <Head ico="🦺" title="실행가능성 & 리스크" by="현장반장" />;
  if (dg.includes("feasibility") || !r.feasibility) {
    return (
      <section className="sec" id="sec-feas">
        {h}
        <Degraded what="실행가능성" />
      </section>
    );
  }
  const f = r.feasibility;
  const tile = (k: string, label: string) => {
    const b = f[k];
    const lv = LV[b.level] || ["", b.level];
    return (
      <div className="tile" key={k}>
        <div className="k">
          {label}{" "}
          <span className={`lv ${b.level}`}>
            {lv[0]} {lv[1]}
          </span>
        </div>
        <div className="v" style={{ fontWeight: 600 }}>
          {b.summary}
        </div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>{b.detail || ""}</div>
        {b.lead_time_weeks && b.lead_time_weeks.value > 0 ? (
          <div style={{ fontSize: 13, marginTop: 8 }}>
            소요 <Num n={b.lead_time_weeks} />
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <section className="sec" id="sec-feas">
      {h}
      <p className="concl">{f.summary}</p>
      <div className="grid4">
        {tile("tech", "기술")}
        {tile("capital", "자금")}
        {tile("people", "인력")}
        {tile("regulation", "규제")}
      </div>
      <p className="fnote">▲ 부담·위험이 큼 · ● 보통 · ▽ 낮음</p>
    </section>
  );
}

function SecCritique({ r, dg }: { r: Report; dg: string[] }) {
  const h = <Head ico="🔻" title="반대파의 반론" by="반대파" />;
  if (dg.includes("critique") || !r.critique) {
    return (
      <section className="sec" id="sec-critic">
        {h}
        <Degraded what="비평" />
      </section>
    );
  }
  const c = r.critique;
  const applied: Report[] = r.meta.applied_adjustments || [];
  const LB = Object.fromEntries(AX);
  const txt = applied.length
    ? applied.map((a) => `${LB[a.axis]} ${a.from}→${a.to}`).join(", ")
    : "근거 링크가 확인된 조정이 없어 점수는 그대로예요";
  return (
    <section className="sec inv" id="sec-critic">
      {h}
      <p className="concl">이 리포트는 자기 결론을 스스로 의심해요. 아래는 위 결론을 공격한 결과예요.</p>
      {c.objections.map((o: Report, i: number) => {
        const u = safeUrl(o.evidence_url);
        return (
          <div className="obj" key={i}>
            <div className="angle">{o.angle}</div>
            <div className="claim">{o.claim}</div>
            <div className="ev">
              {o.evidence}{" "}
              {u ? <ExtLink href={u}>출처</ExtLink> : <span style={{ opacity: 0.8 }}>(근거 링크 없음 · 점수에는 반영되지 않아요)</span>}
            </div>
          </div>
        );
      })}
      <div className="applied">
        <b>점수 반영:</b> {txt}
        <small>반대파는 점수를 직접 고칠 수 없어요. 축당 -2~0점을 제안하고, 근거 링크가 검색 결과에 실제로 있을 때만 반영돼요.</small>
      </div>
    </section>
  );
}

function SecRoadmap({ r, dg }: { r: Report; dg: string[] }) {
  const h = <Head ico="🗺️" title="3단계 로드맵" by="심사위원" />;
  if (dg.includes("roadmap") || !r.roadmap || !r.roadmap.length) {
    return (
      <section className="sec" id="sec-road">
        {h}
        <Degraded what="로드맵" />
      </section>
    );
  }
  return (
    <section className="sec" id="sec-road">
      {h}
      <p className="concl">검증, 최소판매, 확장 순으로 나아가고, 각 단계의 조건을 채우지 못하면 멈춘다.</p>
      <div className="road">
        {r.roadmap.map((s: Report, i: number) => (
          <div className="stage" key={i}>
            <div className="no">{i + 1}</div>
            <div className="st">{s.stage}</div>
            <div className="pd">
              {s.period} · 예상 비용 <Num n={s.cost} />
            </div>
            <ul>
              {s.actions.map((a: string, j: number) => (
                <li key={j}>{a}</li>
              ))}
            </ul>
            <div className="gate">
              <b>다음 단계로 가는 조건</b>
              {s.gate_condition}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Foot({ r, elapsed, onNew }: { r: Report; elapsed?: number; onNew: () => void }) {
  const sources: Report[] = r.sources || [];
  const meta = [elapsed ? `분석 ${Math.round(elapsed)}초` : "", `검색 ${(r.meta.queries_run || []).length}회`].filter(Boolean).join(" · ");
  return (
    <footer className="rf">
      <details>
        <summary>출처 {sources.length}건 보기</summary>
        <ol>
          {sources.length ? (
            sources.map((s, i) => {
              const u = safeUrl(s.url);
              return (
                <li key={i}>
                  {u ? <ExtLink href={u}>{s.title}</ExtLink> : s.title} — {s.used_for}
                </li>
              );
            })
          ) : (
            <li>인용된 출처가 없어요. 모든 수치가 추정치예요.</li>
          )}
        </ol>
      </details>
      <p className="disc">
        본 리포트는 공개된 웹 자료와 업종 표준값에 기반한 <b>참고용 분석</b>이며 투자·창업 권유가 아닙니다.{" "}
        <span className="badge-est" style={{ margin: 0 }}>
          추정치
        </span>{" "}
        표시 수치는 출처를 확인하지 못한 값이에요. 최종 판단과 책임은 이용자에게 있어요. ({meta})
      </p>
      <div className="cta no-print">
        <span className="sp" />
        <button className="btn ghost" onClick={() => window.print()}>
          PDF로 저장
        </button>
        <button className="btn" onClick={onNew}>
          다른 아이디어 분석하기
        </button>
      </div>
    </footer>
  );
}

export default function ReportView({
  report: r,
  sample,
  elapsed,
  onNew,
}: {
  report: Report;
  sample?: boolean;
  elapsed?: number;
  onNew: () => void;
}): ReactNode {
  const dg: string[] = r.degraded_sections || [];
  return (
    <div className="view-report">
      {sample ? <SampleBanner r={r} onNew={onNew} /> : null}
      <Hero r={r} />
      <Facts r={r} />
      <SecSummary r={r} />
      <SecScores r={r} />
      <SecMarket r={r} dg={dg} />
      <SecRoi r={r} dg={dg} />
      <SecFeasibility r={r} dg={dg} />
      <SecCritique r={r} dg={dg} />
      <SecRoadmap r={r} dg={dg} />
      <Foot r={r} elapsed={elapsed} onNew={onNew} />
    </div>
  );
}
