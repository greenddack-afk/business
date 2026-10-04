"""Flask 서버: 분석 요청 · 진행 상태 폴링 · 리포트 전달.

- POST /api/analyze  {idea} → {job_id}   (백그라운드 스레드에서 파이프라인 실행)
- GET  /api/status/<job_id>              → 6개 에이전트 상태 카드 + 완료 시 report
- GET  /                                 → dashboard/index.html

상태 이벤트가 끊겨도 최종 리포트는 status의 report 필드로 도착한다(경로 이중화).
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

import invite
import schema
from agents import normalizer
from pipeline import PipelineAbort, run_pipeline, save_report

ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=None)
logging.basicConfig(level=logging.INFO)

# 진행 화면 카드 규격 — 좌표·크기 고정. 2차 작업에서 이미지로 교체해도 배치가 유지된다.
AGENT_CARDS = [
    {"id": "normalizer", "name": "해석가", "role": "아이디어 해석", "icon": "🔍", "row": 0, "col": 1},
    {"id": "market", "name": "정찰병", "role": "시장 조사", "icon": "🔭", "row": 1, "col": 0},
    {"id": "finance", "name": "회계사", "role": "수익성 계산", "icon": "🧮", "row": 1, "col": 1},
    {"id": "execution", "name": "현장반장", "role": "실행가능성", "icon": "🦺", "row": 1, "col": 2},
    {"id": "critic", "name": "반대파", "role": "반론 제기", "icon": "🔻", "row": 2, "col": 1},
    {"id": "synthesizer", "name": "심사위원", "role": "최종 종합", "icon": "⚖️", "row": 3, "col": 1},
]

JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def _new_job(idea: str) -> dict:
    return {
        "idea": idea,
        "state": "running",  # running | done | error
        "started_at": time.time(),
        "agents": {c["id"]: {"agent_id": c["id"], "status": "idle", "progress_note": "", "ts": 0.0} for c in AGENT_CARDS},
        "report": None,
        "error": None,
        "elapsed": 0.0,
    }


def _run(job_id: str, idea: str, fail_agents: list[str], code: str = "") -> None:
    job = JOBS[job_id]

    def emit(agent_id: str, status: str, note: str = "") -> None:
        with _lock:
            card = job["agents"].get(agent_id)
            if card:
                card.update(status=status, progress_note=note, ts=time.time())

    try:
        out = run_pipeline(idea, emit, fail_agents)
        report = out["report"]
        report["meta"]["saved_as"] = save_report(report).name
        with _lock:
            job["report"] = report
            job["state"] = "done"
    except PipelineAbort as exc:
        with _lock:
            job["state"] = "error"
            job["error"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - 서버가 죽지 않게 한다
        with _lock:
            job["state"] = "error"
            app.logger.exception("pipeline crashed")
            job["error"] = "분석 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요."
    finally:
        if job["state"] == "error" and code:
            invite.refund(code)  # 서비스 쪽 오류로 결과를 못 받았으면 사용 횟수를 돌려준다
        with _lock:
            job["elapsed"] = round(time.time() - job["started_at"], 1)
            for card in job["agents"].values():  # 끝났는데 working으로 남은 카드 정리
                if card["status"] == "working":
                    card["status"] = "done" if job["state"] == "done" else "failed"



def _client_ip() -> str:
    # 프록시(Render 등) 뒤에서는 가장 오른쪽 항목이 프록시가 실제로 본 접속자 IP다. 왼쪽은 접속자가 위조할 수 있다.
    xff = request.headers.get("X-Forwarded-For", "")
    return xff.split(",")[-1].strip() if xff else (request.remote_addr or "?")


def _check_invite(raw):
    """(canon 코드, None) 또는 ("", 오류 응답)."""
    ip = _client_ip()
    if invite.is_locked(ip):
        return "", (jsonify({"error": "코드를 여러 번 잘못 입력했어요. 10분 뒤에 다시 시도해 주세요."}), 429)
    code = invite.authorize(raw)
    if not code:
        invite.record_failure(ip)
        msg = "초대 코드를 입력해 주세요." if not (raw or "").strip() else "초대 코드가 올바르지 않아요. 다시 확인해 주세요."
        return "", (jsonify({"error": msg}), 401)
    return code, None


@app.get("/api/config")
def config():
    return jsonify({"invite_required": invite.required()})


@app.post("/api/invite/check")
def invite_check():
    payload = request.get_json(silent=True) or {}
    code, err = _check_invite(payload.get("code"))
    if err:
        return err
    return jsonify({"ok": True, "remaining": invite.remaining(code), "limit": invite.limits()[2],
                    "lifetime_left": invite.lifetime_left(code)})


@app.post("/api/analyze")
def analyze():
    payload = request.get_json(silent=True) or {}
    idea = (payload.get("idea") or "").strip()

    code = ""
    if invite.required():
        code, err = _check_invite(payload.get("invite_code"))
        if err:
            return err

    ok, reason = normalizer.validate_idea(idea)
    if not ok:
        return jsonify({"error": reason, "examples": normalizer.EXAMPLE_IDEAS}), 400

    if code:
        used, why = invite.consume(code)
        if not used:
            return jsonify({"error": why}), 429

    # 부분 실패 시연용 훅. 판매용 서버에서는 꺼 둔다(기본 off). 개발 PC의 .env에 ALLOW_FAIL_INJECTION=1 을 넣으면 켜진다.
    fail_agents = []
    if os.getenv("ALLOW_FAIL_INJECTION") == "1":
        fail_agents = [a for a in (payload.get("fail_agents") or []) if a in schema.AGENT_IDS]
    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = _new_job(idea)
    threading.Thread(target=_run, args=(job_id, idea, fail_agents, code), daemon=True).start()
    return jsonify({"job_id": job_id})


@app.get("/api/status/<job_id>")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        return jsonify({"error": "알 수 없는 job_id"}), 404
    with _lock:
        return jsonify({
            "state": job["state"],
            "idea": job["idea"],
            "elapsed": round(time.time() - job["started_at"], 1) if job["state"] == "running" else job["elapsed"],
            "agents": [{**card, **job["agents"][card["id"]]} for card in AGENT_CARDS],
            "report": job["report"],
            "error": job["error"],
        })


@app.get("/api/examples")
def examples():
    return jsonify({"examples": normalizer.EXAMPLE_IDEAS})


@app.get("/")
def index():
    return send_from_directory(ROOT / "dashboard", "index.html")


@app.get("/<path:filename>")
def dashboard_files(filename: str):
    return send_from_directory(ROOT / "dashboard", filename)


if __name__ == "__main__":
    print("대시보드: http://127.0.0.1:5000")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
