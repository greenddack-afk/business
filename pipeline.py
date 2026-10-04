"""오케스트레이터: 순서 제어 · 병렬 실행 · 스키마 검증 · 부분 실패 허용.

데이터 흐름: 정규화 → 공용 검색 → (시장·재무·실행 병렬) → 1차 종합 → 비평 1회 → 최종 종합.
CLI: python pipeline.py "따뜻한 폼롤러" [--fail finance]
"""
from __future__ import annotations

import json
import logging
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

import schema
from agents import Emit, critic, execution, finance, market, noop_emit, normalizer, synthesizer
from search_pool import SearchPool

CONCURRENCY = 3
log = logging.getLogger("analyzer")
USER_FACING_ERROR = "분석 서비스에 일시적인 문제가 있어 결과를 만들지 못했어요. 잠시 후 다시 시도해 주세요."
REPORT_DIR = Path(__file__).resolve().parent / "reports"


class PipelineAbort(Exception):
    """정규화 실패·입력 무효처럼 더 진행할 수 없을 때만 사용한다(개별 에이전트 실패는 여기 해당하지 않음)."""


def prepare(idea: str, emit: Emit = noop_emit) -> tuple[dict, SearchPool]:
    ok, reason = normalizer.validate_idea(idea)
    if not ok:
        raise PipelineAbort(reason)
    norm = normalizer.run(idea, emit)
    if not norm.ok:
        log.error("normalizer failed: %s", norm.errors[:3])  # 기술 원인은 서버 로그에만 남긴다
        raise PipelineAbort(USER_FACING_ERROR)
    pool = SearchPool().collect(norm.data["queries"], emit, agent_id="market")
    return norm.data, pool


def run_specialists(norm: dict, pool: SearchPool, emit: Emit, fail_agents: Iterable[str] = ()) -> dict[str, schema.AgentResult]:
    """시장·재무·실행을 동시성 3으로 병렬 실행. 하나가 실패해도 나머지는 계속된다."""
    fail = set(fail_agents)
    modules = {"market": market, "finance": finance, "execution": execution}

    def task(agent_id: str) -> schema.AgentResult:
        return modules[agent_id].run(norm, pool, emit, force_fail=agent_id in fail)

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as ex:
        futures = {a: ex.submit(task, a) for a in modules}
        return {a: f.result() for a, f in futures.items()}


SECTION_OF = {"market": "market", "finance": "roi", "execution": "feasibility", "critic": "critique"}


def run_pipeline(idea: str, emit: Emit = noop_emit, fail_agents: Iterable[str] = ()) -> dict:
    """한 줄 아이디어 → 최종 리포트 dict. 개별 에이전트가 실패해도 그 섹션만 비우고 끝까지 간다."""
    fail = set(fail_agents)
    normalized, pool = prepare(idea, emit)

    results = run_specialists(normalized, pool, emit, fail)
    if not any(results[a].ok for a in ("market", "finance", "execution")):
        # 3명이 모두 실패하면 남는 게 없다. 빈 D등급 리포트는 진짜 평가로 오해되므로 오류로 끝낸다.
        for a, r in results.items():
            log.error("%s failed: %s", a, r.errors[:2])
        raise PipelineAbort(USER_FACING_ERROR)
    sections = {a: (r.data if r.ok else None) for a, r in results.items()}
    draft = synthesizer.draft(sections["market"], sections["finance"], sections["execution"])

    crit = critic.run(normalized, pool, draft, sections, emit, force_fail="critic" in fail)
    results["critic"] = crit
    critique = crit.data if crit.ok else None
    final_scores, applied = critic.apply_adjustments(draft["scores"], critique, pool.allowed_urls)

    degraded = [SECTION_OF[a] for a in ("market", "finance", "execution", "critic") if not results[a].ok]
    report, synth = synthesizer.finalize(
        idea, normalized, pool, sections, final_scores, applied, critique, degraded, emit,
        force_fail="synthesizer" in fail,
    )
    results["synthesizer"] = synth

    errors = schema.validate("synthesizer", report)
    report["meta"]["schema_errors"] = errors  # 비어 있어야 정상
    report["meta"]["draft_grade"] = draft["grade"]
    report["meta"]["search"] = {"urls": len(pool.results), "failed_queries": pool.failed_queries}
    return {"report": report, "results": results, "pool": pool, "draft": draft, "schema_errors": errors}


def save_report(report: dict) -> Path:
    REPORT_DIR.mkdir(exist_ok=True)
    name = datetime.now().strftime("%Y%m%d_%H%M%S") + ".json"
    path = REPORT_DIR / name
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _print_report(report: dict) -> None:
    v = report["verdict"]
    print(f"\n{'=' * 64}\n  종합 등급 {v['grade']} · {v['decision']}\n  {v['one_liner']}\n{'=' * 64}")

    print("\n[가정]")
    for a in report["assumptions"]:
        print(f"  · {a['key']}: {a['value']}")

    print("\n[5축 점수]")
    for axis in schema.AXES:
        s = report["scores"][axis]
        label = schema.AXIS_LABELS[axis]
        if not s:
            print(f"  {label:<4} (데이터 부족 — 분석에서 제외됨)")
            continue
        adj = f"  ({s['adjusted_from']}→{s['score']} 비평 반영)" if s.get("adjusted_from") is not None else ""
        print(f"  {label:<4} {'█' * s['score']}{'░' * (10 - s['score'])} {s['score']:>2}/10{adj}")
        print(f"       {s['rationale'][:100]}")
    print(f"\n  가중 평균 {report['meta']['weighted_average']} (초안 {report['meta']['draft_grade']} → 최종 {v['grade']})")

    roi = report.get("roi")
    if roi:
        be, sc = roi["break_even"], roi["scenarios"]
        print(f"\n[ROI] 손익분기 월 {be['units_per_month']['value']:,.0f}개 · 회수 {be['payback_months']['value']:g}개월")
        print("  12개월 누적: " + " / ".join(f"{k} {sc[k]['cumulative_profit_12m']['value']:+,.0f}만원" for k in ("conservative", "base", "optimistic")))

    crit = report.get("critique")
    if crit:
        print("\n[비평가 반론]")
        for i, o in enumerate(crit["objections"], 1):
            mark = "🔗" if o.get("evidence_url") else "  "
            print(f"  {i}. [{o['angle']}] {o['claim'][:80]} {mark}")
        applied = report["meta"]["applied_adjustments"]
        print(f"  → 반영: {', '.join(f'{schema.AXIS_LABELS[a['axis']]} {a['from']}→{a['to']}' for a in applied) if applied else '근거 있는 조정 없음'}")

    if report["roadmap"]:
        print("\n[3단계 로드맵]")
        for st in report["roadmap"]:
            print(f"  {st['stage']} ({st['period']}) · {st['cost']['value']:,.0f}만원")
            for act in st["actions"][:3]:
                print(f"      - {act[:80]}")
            print(f"      ▸ 진입 조건: {st['gate_condition'][:80]}")

    print(f"\n[출처] {len(report['sources'])}개 · degraded_sections={report['degraded_sections']}")


def _cli() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    args = sys.argv[1:]
    fail: list[str] = []
    if "--fail" in args:
        i = args.index("--fail")
        fail = args[i + 1].split(",")
        del args[i : i + 2]
    idea = " ".join(args).strip() or "따뜻한 폼롤러"

    def emit(agent_id: str, status: str, note: str = "") -> None:
        print(f"  [{time.strftime('%H:%M:%S')}] {agent_id:<11} {status:<8} {note}")

    print(f"아이디어: {idea}" + (f"   (의도적 실패: {fail})" if fail else "") + "\n")
    t0 = time.time()
    try:
        out = run_pipeline(idea, emit, fail)
    except PipelineAbort as exc:
        print(f"중단: {exc}")
        raise SystemExit(1)

    for agent_id, r in out["results"].items():
        if not r.ok:
            print(f"  ✗ {agent_id} 실패({r.attempts}회 시도): {r.errors[:2]}")
    _print_report(out["report"])

    path = save_report(out["report"])
    errs = out["schema_errors"]
    print(f"\n리포트 저장: {path.name}  (스키마 검증 {'통과' if not errs else '실패: ' + str(errs[:3])})")
    print(f"소요 {time.time() - t0:.1f}초 · 검색 URL {len(out['pool'].results)}개")
    from llm import USAGE
    print(f"LLM 호출 {USAGE['calls']}회 · 캐시 적중 {USAGE['cache_hits']}회 · 토큰 in/out {USAGE['input_tokens']}/{USAGE['output_tokens']}")


if __name__ == "__main__":
    _cli()
