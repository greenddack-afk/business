"use client";

import { useEffect, useState } from "react";
import type { AgentCard } from "@/lib/cards";

const TIPS = [
  "모든 숫자에는 출처가 붙어요. 출처를 못 찾은 숫자는 [추정치]로 표시해요.",
  "반대파는 앞선 세 명의 결과가 나온 뒤에야 등장해서 그 결론을 공격해요.",
  "반론은 근거 링크가 확인될 때만 점수에 반영돼요. 트집으로는 점수가 깎이지 않아요.",
  "손익분기점은 “이만큼 팔아야 본전”이 되는 월 판매량이에요. 리포트에서 가장 크게 보여 드려요.",
  "한 명이 실패해도 리포트는 나와요. 그 항목만 “데이터 부족”으로 표시돼요.",
];
const ST: Record<string, string> = { idle: "대기 중", working: "작업 중", done: "완료", failed: "제외됨" };

// 카드 규격: cw=176, ch=150, 열 간격 40, 행 간격 26 (CSS 변수 --cw/--ch와 동일)
const CW = 176,
  CH = 150,
  GX = 40,
  GY = 26;

/** 카드 중심선을 잇는 점선 */
function FlowLines() {
  const X = (c: number) => c * (CW + GX) + CW / 2;
  const Y = (r: number) => r * (CH + GY);
  const p: string[] = [];
  for (const c of [0, 1, 2]) {
    p.push(`M${X(1)} ${Y(0) + CH} C${X(1)} ${Y(1) - 12} ${X(c)} ${Y(1) - 14} ${X(c)} ${Y(1)}`);
    p.push(`M${X(c)} ${Y(1) + CH} C${X(c)} ${Y(2) - 12} ${X(1)} ${Y(2) - 14} ${X(1)} ${Y(2)}`);
  }
  p.push(`M${X(1)} ${Y(2) + CH} L${X(1)} ${Y(3)}`);
  return (
    <svg viewBox={`0 0 ${CW * 3 + GX * 2} ${CH * 4 + GY * 3}`} aria-hidden="true">
      {p.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = matchMedia("(max-width:680px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

export default function ProgressView({ idea, agents }: { idea: string; agents: AgentCard[] }) {
  const [elapsed, setElapsed] = useState(0);
  const [tip, setTip] = useState(0);
  const narrow = useNarrow();

  useEffect(() => {
    const t0 = Date.now();
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    const tips = setInterval(() => setTip((i) => (i + 1) % TIPS.length), 7000);
    return () => {
      clearInterval(clock);
      clearInterval(tips);
    };
  }, [idea]);

  const done = agents.filter((a) => a.status === "done" || a.status === "failed").length;
  const working = agents.find((a) => a.status === "working");
  const meterTxt = working ? `${working.name}가 일하는 중` : agents.length && done === agents.length ? "마무리하는 중" : agents.length ? "준비 중" : "시작하는 중";

  return (
    <div className="view-progress">
      <h2>“{idea}” 분석 중이에요</h2>
      <p className="sub">
        <span>{elapsed}</span>초 경과 · 보통 2분 안팎 걸려요. 창을 닫지 말고 잠시만 기다려 주세요.
      </p>
      <div className="meter" aria-hidden="true">
        <div className="bar">
          <i style={{ width: `${agents.length ? (done / agents.length) * 100 : 0}%` }} />
        </div>
        <div className="cap">
          <span>{meterTxt}</span>
          <span>
            {done} / {agents.length || 6}
          </span>
        </div>
      </div>
      <div className="flow">
        {agents.length ? <FlowLines /> : null}
        {agents.map((a) => (
          <div
            key={a.id}
            className="card"
            data-status={a.status}
            style={narrow ? undefined : { left: a.col * (CW + GX), top: a.row * (CH + GY) }}
          >
            <div className="avatar" aria-hidden="true">
              {a.icon}
            </div>
            <div className="body">
              <div className="nm">{a.name}</div>
              <div className="st">{ST[a.status] || ""}</div>
              <div className="note">{a.status === "failed" ? "이 항목은 제외됐어요" : a.progress_note || a.role}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="tip">💡 {TIPS[tip]}</div>
    </div>
  );
}
