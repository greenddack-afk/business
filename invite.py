"""초대 코드 · 하루 사용 횟수 제한 (비공개 시범 운영용).

- 코드가 하나라도 등록돼 있으면 분석(/api/analyze)은 유효한 초대 코드가 있어야만 실행된다.
  코드가 하나도 없으면 열린 상태(개발용)다. 배포 서버에서는 REQUIRE_INVITE=1 을 켜 두면
  코드 설정이 빠졌을 때도 '전부 거부'로 닫힌다(fail closed).
- 코드 출처: 환경변수 INVITE_CODES("코드:메모,코드:메모") + 파일 data/invite_codes.txt ("코드  # 메모").
- 횟수 제한 3종 (0으로 두면 그 제한은 끔):
    LIFETIME_LIMIT_PER_CODE  코드당 평생 총 횟수 (기본 5)  ← 날짜와 무관하게 누적
    DAILY_LIMIT_PER_CODE     코드당 하루 횟수 (기본 0=끔, 한국시간 기준)
    DAILY_LIMIT_TOTAL        서비스 전체 하루 횟수 (기본 30) ← 비용 상한: 30회 × 약 $0.9 ≈ 하루 최대 $27
- 코드 무차별 대입 방어: 같은 IP에서 10분 안에 5번 틀리면 10분간 잠근다.
- 분석이 서비스 오류로 실패하면 사용 횟수를 돌려준다(refund).
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # 헷갈리는 글자(0 O 1 I L) 제외
KST = timezone(timedelta(hours=9))
LOCK_AFTER, LOCK_WINDOW = 5, 600  # 5번 실패 / 10분

_lock = threading.RLock()
_failures: dict[str, deque] = defaultdict(deque)


def _codes_file() -> Path:
    return Path(os.getenv("INVITE_CODES_FILE") or ROOT / "data" / "invite_codes.txt")


def _usage_file() -> Path:
    return Path(os.getenv("USAGE_FILE") or ROOT / "data" / "usage.json")


def canon(code: Optional[str]) -> str:
    """대소문자·하이픈·공백 차이를 무시한 비교용 형태."""
    return re.sub(r"[^A-Z0-9]", "", (code or "").upper())


def load_codes() -> dict[str, dict]:
    """{canon: {"code": 표시용, "label": 메모}}"""
    found: dict[str, dict] = {}

    def add(raw: str, label: str = "") -> None:
        c = canon(raw)
        if len(c) >= 6:
            found[c] = {"code": raw.strip().upper(), "label": label.strip()}

    for part in (os.getenv("INVITE_CODES") or "").split(","):
        if part.strip():
            code, _, label = part.partition(":")
            add(code, label)
    path = _codes_file()
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            body, _, label = line.partition("#")
            if body.strip():
                add(body, label)
    return found


def required() -> bool:
    return os.getenv("REQUIRE_INVITE") == "1" or bool(load_codes())


def _lifetime_file() -> Path:
    return Path(os.getenv("LIFETIME_FILE") or ROOT / "data" / "lifetime.json")


def limits() -> tuple[int, int, int]:
    """(코드당 하루, 전체 하루, 코드당 평생). 0이면 그 제한은 끈다."""
    return (int(os.getenv("DAILY_LIMIT_PER_CODE") or 0),
            int(os.getenv("DAILY_LIMIT_TOTAL") or 30),
            int(os.getenv("LIFETIME_LIMIT_PER_CODE") or 5))


# ---------------------------------------------------------------- 무차별 대입 방어
def is_locked(ip: str) -> bool:
    with _lock:
        q, now = _failures[ip], time.time()
        while q and now - q[0] > LOCK_WINDOW:
            q.popleft()
        return len(q) >= LOCK_AFTER


def record_failure(ip: str) -> None:
    with _lock:
        _failures[ip].append(time.time())


def reset_state() -> None:
    with _lock:
        _failures.clear()


# ---------------------------------------------------------------- 인증
def authorize(code: Optional[str]) -> Optional[str]:
    """유효하면 canon 코드를 돌려준다. 아니면 None. (상수 시간 비교)"""
    given = canon(code)
    if not given:
        return None
    match = None
    for c in load_codes():
        if hmac.compare_digest(c, given):
            match = c
    return match


# ---------------------------------------------------------------- 사용량
def _today() -> str:
    return datetime.now(KST).date().isoformat()


def _load_usage() -> dict:
    fresh = {"date": _today(), "codes": {}, "total": 0}
    path = _usage_file()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("date") == fresh["date"]:
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return fresh


def _save_usage(data: dict) -> None:
    path = _usage_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # 저장 실패해도 서비스는 계속(재시작 시 횟수만 초기화됨)


def _load_lifetime() -> dict[str, int]:
    try:
        data = json.loads(_lifetime_file().read_text(encoding="utf-8"))
        return {k: int(v) for k, v in data.items()}
    except (OSError, json.JSONDecodeError, ValueError, AttributeError):
        return {}


def _save_lifetime(data: dict[str, int]) -> None:
    path = _lifetime_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def remaining(code_canon: str) -> int:
    """지금 이 코드로 쓸 수 있는 횟수(적용 중인 제한 중 가장 빡빡한 것 기준)."""
    per, total, life = limits()
    with _lock:
        u, lt = _load_usage(), _load_lifetime()
        options = [total - u["total"]]
        if per > 0:
            options.append(per - u["codes"].get(code_canon, 0))
        if life > 0:
            options.append(life - lt.get(code_canon, 0))
        return max(0, min(options))


def lifetime_left(code_canon: str) -> Optional[int]:
    """평생 한도에서 남은 횟수. 평생 제한을 껐으면 None."""
    life = limits()[2]
    if life <= 0:
        return None
    with _lock:
        return max(0, life - _load_lifetime().get(code_canon, 0))


def consume(code_canon: str) -> tuple[bool, str]:
    """횟수를 1 차감한다. (성공 여부, 실패 사유 메시지)"""
    per, total, life = limits()
    with _lock:
        u, lt = _load_usage(), _load_lifetime()
        if life > 0 and lt.get(code_canon, 0) >= life:
            return False, f"이 초대 코드의 사용 횟수({life}회)를 모두 썼어요."
        if u["total"] >= total:
            return False, "오늘 서비스 전체 사용량이 가득 찼어요. 내일 다시 이용해 주세요."
        if per > 0 and u["codes"].get(code_canon, 0) >= per:
            return False, f"이 초대 코드의 오늘 사용 횟수({per}회)를 모두 썼어요. 내일 다시 이용해 주세요."
        u["codes"][code_canon] = u["codes"].get(code_canon, 0) + 1
        u["total"] += 1
        lt[code_canon] = lt.get(code_canon, 0) + 1
        _save_usage(u)
        _save_lifetime(lt)
        return True, ""


def refund(code_canon: str) -> None:
    """서비스 오류로 결과를 못 줬을 때 횟수를 돌려준다(평생 횟수 포함)."""
    with _lock:
        u, lt = _load_usage(), _load_lifetime()
        if u["codes"].get(code_canon, 0) > 0:
            u["codes"][code_canon] -= 1
            u["total"] = max(0, u["total"] - 1)
            _save_usage(u)
        if lt.get(code_canon, 0) > 0:
            lt[code_canon] -= 1
            _save_lifetime(lt)


def reset_lifetime(code: str) -> bool:
    """관리용: 그 코드의 누적 사용 횟수를 0으로 되돌린다(더 쓰게 해 주고 싶을 때)."""
    c = canon(code)
    with _lock:
        lt = _load_lifetime()
        if c not in lt:
            return False
        lt[c] = 0
        _save_lifetime(lt)
        return True


def usage_report() -> dict:
    with _lock:
        return {**_load_usage(), "lifetime": _load_lifetime()}


# ---------------------------------------------------------------- 코드 발급 (관리용)
def generate(n: int, label: str = "") -> list[str]:
    """새 코드 n개를 만들어 data/invite_codes.txt에 추가하고 돌려준다. 형식: ABCD-EFGH-JKMN"""
    existing = set(load_codes())
    new: list[str] = []
    while len(new) < n:
        raw = "".join(secrets.choice(ALPHABET) for _ in range(12))
        if canon(raw) in existing:
            continue
        existing.add(canon(raw))
        new.append(f"{raw[:4]}-{raw[4:8]}-{raw[8:]}")
    path = _codes_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        for i, code in enumerate(new, 1):
            f.write(f"{code}  # {label}{i if label and n > 1 else ''}\n".replace("  # \n", "\n"))
    return new


def revoke(code: str) -> bool:
    path = _codes_file()
    if not path.exists():
        return False
    target, kept, removed = canon(code), [], False
    for line in path.read_text(encoding="utf-8").splitlines():
        if canon(line.partition("#")[0]) == target and target:
            removed = True
        else:
            kept.append(line)
    path.write_text("\n".join(kept) + ("\n" if kept else ""), encoding="utf-8")
    return removed
