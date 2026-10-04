"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCard, StreamEvent } from "@/lib/cards";
import type { Report } from "./format";
import ProgressView from "./Progress";
import ReportView, { NAV } from "./Report";

type View = "input" | "progress" | "report";

/** 주소창 쿼리값. 화면이 서버에서 먼저 그려지도록 렌더 중이 아니라 이벤트·effect 안에서만 읽는다. */
const query = (k: string) => new URLSearchParams(window.location.search).get(k);

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) || "";
    } catch {
      return "";
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 저장 못 해도 동작에는 지장 없다 */
    }
  },
};

/* 서버(lib/agents/normalizer.validateIdea)와 같은 규칙. 무의미 입력은 LLM 호출 전에 여기서 막는다. */
function validateIdea(t: string): string {
  if (!t) return "아이디어를 한 줄 적어 주세요.";
  if ([...t].length < 2) return "너무 짧아요. 제품이나 서비스가 드러나게 적어 주세요.";
  if ([...t].length > 100) return "100자 이내 한 줄로 적어 주세요.";
  if (!/[가-힣]{2,}|[A-Za-z]{2,}/.test(t)) return "사업 아이템으로 읽히지 않아요. 아래 예시처럼 적어 보세요.";
  if (new Set([...t.replace(/\s/g, "")]).size <= 2 && [...t].length >= 4) return "같은 글자가 반복돼 있어요. 아래 예시처럼 적어 보세요.";
  return "";
}

const BrandIcon = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <path d="M16 6l9.5 6.9-3.6 11.2H10.1L6.5 12.9z" fill="none" stroke="var(--accent-ink)" strokeWidth="2" strokeLinejoin="round" />
    <path d="M16 12l4.8 3.5-1.8 5.6h-6l-1.8-5.6z" fill="var(--accent-ink)" />
  </svg>
);

export default function AnalyzerApp() {
  const [view, setView] = useState<View>("input");
  const [idea, setIdea] = useState("");
  const [runningIdea, setRunningIdea] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [examples, setExamples] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [report, setReport] = useState<{ data: Report; sample?: boolean; elapsed?: number } | null>(null);
  const [activeNav, setActiveNav] = useState("");

  const [inviteRequired, setInviteRequired] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteNote, setInviteNote] = useState<{ txt: string; cls: string }>({ txt: "샘플 리포트는 코드 없이 볼 수 있어요.", cls: "" });

  const ideaRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<AbortController | null>(null);

  const show = useCallback((v: View) => {
    setView(v);
    window.scrollTo(0, 0);
  }, []);

  const goHome = useCallback(() => {
    runRef.current?.abort();
    runRef.current = null;
    history.replaceState(null, "", location.pathname);
    show("input");
  }, [show]);

  /* ---------- 초대 코드 (서버가 요구할 때만 보인다) ---------- */
  const checkInvite = useCallback(async (raw: string): Promise<boolean> => {
    const code = raw.trim();
    if (!code) {
      setInviteNote({ txt: "샘플 리포트는 코드 없이 볼 수 있어요.", cls: "" });
      return false;
    }
    try {
      const r = await fetch("/api/invite/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const d = await r.json();
      if (!r.ok) {
        setInviteNote({ txt: d.error || "확인하지 못했어요.", cls: "bad" });
        return false;
      }
      store.set("inviteCode", code);
      if (d.remaining > 0) {
        setInviteNote({ txt: d.lifetime_left != null ? `확인됐어요 · 총 ${d.limit}회 중 ${d.lifetime_left}회 남았어요` : "확인됐어요", cls: "ok" });
      } else if (d.lifetime_left === 0) {
        setInviteNote({ txt: `이 코드의 사용 횟수(${d.limit}회)를 모두 썼어요.`, cls: "bad" });
      } else {
        setInviteNote({ txt: "오늘 서비스 사용량이 가득 찼어요. 내일 다시 이용해 주세요.", cls: "bad" });
      }
      return true;
    } catch {
      setInviteNote({ txt: "서버에 연결하지 못했어요.", cls: "bad" });
      return false;
    }
  }, []);

  const openSample = useCallback(async () => {
    try {
      const r = await fetch("/sample_report.json");
      setReport({ data: await r.json(), sample: true });
      show("report");
    } catch {
      setErr("샘플을 불러오지 못했어요.");
    }
  }, [show]);

  useEffect(() => {
    fetch("/api/examples")
      .then((r) => r.json())
      .then((d) => setExamples(d.examples || []))
      .catch(() => {});
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => {
        if (!c.invite_required) return;
        setInviteRequired(true);
        const saved = store.get("inviteCode");
        setInviteCode(saved);
        if (saved) checkInvite(saved);
      })
      .catch(() => {});
    // 개발용: 주소 끝 ?sample=1 → 샘플 바로 열기
    if (query("sample")) openSample();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 분석 실행: 서버가 보내는 진행 이벤트(NDJSON)를 읽는다 ---------- */
  async function start(text = idea) {
    const t = text.trim();
    const bad = validateIdea(t);
    if (bad) {
      setErr(bad);
      ideaRef.current?.focus();
      return;
    }
    const code = inviteCode.trim();
    if (inviteRequired && !code) {
      setErr("초대 코드를 입력해 주세요. 샘플 리포트는 코드 없이 볼 수 있어요.");
      codeRef.current?.focus();
      return;
    }
    setErr("");
    setBusy(true);
    const ctrl = new AbortController();
    runRef.current = ctrl;
    // 개발용: 주소 끝 ?fail=finance → 재무 에이전트를 일부러 실패시켜 부분 실패 화면 확인(서버에서 허용했을 때만)
    const fail = query("fail");
    let started = false;
    const failBack = (msg: string) => {
      if (ctrl.signal.aborted) return;
      show("input");
      setErr(msg);
      if (inviteRequired) checkInvite(code);
    };
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea: t, invite_code: code, fail_agents: fail ? fail.split(",") : [] }),
        signal: ctrl.signal,
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => ({}));
        setErr(d.error || "요청을 처리하지 못했어요.");
        if (inviteRequired) checkInvite(code);
        return;
      }
      store.set("inviteCode", code);
      started = true;
      setBusy(false);
      setRunningIdea(t);
      setAgents([]);
      show("progress");

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as StreamEvent;
          if (ev.type === "agents") setAgents(ev.agents);
          else if (ev.type === "done") {
            finished = true;
            setAgents(ev.agents);
            setReport({ data: ev.report, elapsed: ev.elapsed });
            show("report");
            if (inviteRequired) checkInvite(code);
          } else if (ev.type === "error") {
            finished = true;
            failBack(ev.error || "분석 중 문제가 생겼어요.");
          }
        }
      }
      if (!finished) failBack("서버와 연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
    } catch {
      if (started) failBack("서버와 연결이 끊겼어요. 잠시 후 다시 시도해 주세요.");
      else if (!ctrl.signal.aborted) setErr("서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
      if (runRef.current === ctrl) runRef.current = null;
    }
  }

  /* ---------- 리포트 목차: 보이는 섹션을 상단바에 표시 ---------- */
  useEffect(() => {
    if (view !== "report") return;
    const spy = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setActiveNav(e.target.id)),
      { rootMargin: "-25% 0px -65% 0px" },
    );
    NAV.forEach(([id]) => {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    });
    return () => spy.disconnect();
  }, [view, report]);

  const rep = view === "report";

  return (
    <>
      <header className="topbar no-print">
        <div className="wrap in">
          <button className="brand" aria-label="처음 화면으로" onClick={goHome}>
            <BrandIcon />
            사업아이템 분석기
          </button>
          {rep ? (
            <nav className="nav" aria-label="리포트 목차">
              {NAV.map(([id, t]) => (
                <a key={id} href={`#${id}`} className={activeNav === id ? "on" : ""}>
                  {t}
                </a>
              ))}
            </nav>
          ) : null}
          <div className="sp" />
          {rep && report?.sample ? <span className="tag-sample">샘플</span> : null}
          {rep ? (
            <button className="btn ghost" onClick={() => window.print()}>
              PDF로 저장
            </button>
          ) : (
            <button className="btn ghost" onClick={openSample}>
              샘플 리포트 보기
            </button>
          )}
          {rep ? (
            <button className="btn sm" onClick={goHome}>
              새 분석
            </button>
          ) : null}
        </div>
      </header>

      <main className="wrap">
        {view === "input" ? (
          <div>
            <div className="land-hero">
              <span className="pill">🧭 투자 심사역의 시선으로</span>
              <h1>
                떠오른 아이디어,
                <br />
                <em>사업이 될까요?</em>
              </h1>
              <p className="sub">
                한 줄만 적어 주세요. 시장·수익·실행·리스크를 조사하고, 스스로 반박까지 해 본 리포트를 보통 2분 안팎에 만들어 드려요.
              </p>

              <form
                className="ask"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  start();
                }}
              >
                <label className="sr" htmlFor="idea">
                  사업 아이디어 한 줄
                </label>
                <input
                  id="idea"
                  ref={ideaRef}
                  type="text"
                  placeholder="예: 따뜻한 폼롤러"
                  maxLength={100}
                  enterKeyHint="go"
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                />
                <button className="btn" type="submit" disabled={busy}>
                  분석 시작하기
                </button>
              </form>
              {inviteRequired ? (
                <div className="invite">
                  <label htmlFor="invite-code">초대 코드</label>
                  <input
                    id="invite-code"
                    ref={codeRef}
                    type="text"
                    placeholder="예: ABCD-EFGH-JKMN"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={24}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    onBlur={(e) => checkInvite(e.target.value)}
                  />
                  <span className={`note ${inviteNote.cls}`}>{inviteNote.txt}</span>
                </div>
              ) : null}
              <div className="err" role="alert">
                {err}
              </div>
              <div className="examples">
                <span className="lead">이런 아이디어로 시작해 보세요</span>
                {examples.map((ex) => (
                  <button
                    key={ex}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setIdea(ex);
                      start(ex);
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
              <p className="meta-line">
                먼저 결과가 궁금하다면{" "}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    openSample();
                  }}
                >
                  샘플 리포트 보기
                </a>{" "}
                · 실제 분석 결과 예시예요
              </p>
            </div>

            <div className="how">
              <h2>이렇게 만들어져요</h2>
              <p className="lead">여섯 명의 전문가가 역할을 나눠 일하고, 마지막에는 서로의 결론을 의심해요.</p>
              <div className="crew">
                <div className="c">
                  <div className="step">STEP 1</div>
                  <h3>한 줄을 구조로 풀어요</h3>
                  <p>아이디어를 제품·타깃·차별점으로 해석하고, 부족한 정보는 가정으로 채워 그 가정을 리포트 맨 위에 공개해요.</p>
                  <div className="faces">
                    <span className="face">
                      <i>🔍</i>해석가
                    </span>
                  </div>
                </div>
                <div className="c">
                  <div className="step">STEP 2</div>
                  <h3>세 명이 동시에 분석해요</h3>
                  <p>웹에서 근거를 모은 뒤 시장, 수익, 실행 가능성을 나눠서 동시에 살펴봐요.</p>
                  <div className="faces">
                    <span className="face">
                      <i>🔭</i>정찰병
                    </span>
                    <span className="face">
                      <i>🧮</i>회계사
                    </span>
                    <span className="face">
                      <i>🦺</i>현장반장
                    </span>
                  </div>
                </div>
                <div className="c">
                  <div className="step">STEP 3</div>
                  <h3>반박한 뒤 종합해요</h3>
                  <p>반대파가 결론의 약점을 3가지 각도로 공격하고, 심사위원이 근거가 확인된 반론만 반영해 등급을 매겨요.</p>
                  <div className="faces">
                    <span className="face">
                      <i>🔻</i>반대파
                    </span>
                    <span className="face">
                      <i>⚖️</i>심사위원
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="trust">
              <h2>믿고 볼 수 있게 만들었어요</h2>
              <p className="lead">그럴듯한 숫자보다, 어디서 온 숫자인지가 더 중요하니까요.</p>
              <div className="grid">
                <div className="t">
                  <div className="ic">🔗</div>
                  <h3>모든 숫자에 출처</h3>
                  <p>
                    출처를 확인한 수치는 링크와 함께, 확인하지 못한 수치는 <span className="est-demo">회색 점선</span>{" "}
                    <span className="badge-est">추정치</span> 배지로 구분해 보여줘요.
                  </p>
                </div>
                <div className="t">
                  <div className="ic">🛡️</div>
                  <h3>스스로 반박해요</h3>
                  <p>낙관에 빠지지 않도록 “이미 존재한다·숨은 비용·고객이 돈을 안 낸다” 세 가지 반론을 반드시 붙여요.</p>
                </div>
                <div className="t">
                  <div className="ic">🪟</div>
                  <h3>가정을 숨기지 않아요</h3>
                  <p>초기 자본, 판매가, 판매 채널 같은 가정을 맨 위에 펼쳐 둬요. 내 상황과 다르면 결과도 달라진다는 걸 바로 알 수 있어요.</p>
                </div>
              </div>
            </div>

            <div className="land-foot">본 서비스의 리포트는 공개 웹 자료와 업종 표준값에 기반한 참고용 분석이며, 투자·창업 권유가 아닙니다.</div>
          </div>
        ) : null}

        {view === "progress" ? <ProgressView idea={runningIdea} agents={agents} /> : null}

        {view === "report" && report ? (
          <ReportView report={report.data} sample={report.sample} elapsed={report.elapsed} onNew={goHome} />
        ) : null}
      </main>
    </>
  );
}
