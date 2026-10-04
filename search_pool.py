"""공용 검색 풀: 쿼리 중복 제거 · 최대 8회 · 결과 캐시. 검색은 파이프라인에서 이 한 곳에서만 일어난다.

검색 엔진은 Anthropic API 내장 웹 검색 도구(별도 API 키 불필요)이다.
쿼리마다 Haiku가 검색을 1회 수행하고, 인용된 원문 조각(cited_text)을 snippet으로 저장한다.
"""
from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from agents import Emit, noop_emit
from llm import FAST_MODEL, WEB_SEARCH_TOOL, call_llm

MAX_QUERIES = 8
WORKERS = 8  # 한 배치로 끝내 검색 지연을 줄인다
SNIPPET_MAX = 400

_SYSTEM = """너는 사업 조사용 검색 수집기다. 주어진 검색어로 웹 검색을 정확히 1회 수행하고,
결과에서 확인되는 사실 중 **숫자가 있는 것**(시장 규모, 성장률, 가격, 수수료율, 인증 소요 기간, 비용 등)을 우선해
한국어 bullet 3~5개로 정리해라. 확인되지 않은 내용은 쓰지 마라. 응원·군더더기 문장 금지."""


def _norm(q: str) -> set[str]:
    return set(re.findall(r"[가-힣A-Za-z0-9]+", q.lower()))


def dedupe_queries(queries: list[str], limit: int = MAX_QUERIES) -> list[str]:
    """공백·구두점 차이와 어순만 다른 쿼리(토큰 집합 Jaccard ≥ 0.8)를 제거하고 상한을 적용한다."""
    kept: list[tuple[str, set[str]]] = []
    for q in queries:
        toks = _norm(q)
        if not toks:
            continue
        if any(len(toks & t) / len(toks | t) >= 0.8 for _, t in kept):
            continue
        kept.append((q.strip(), toks))
        if len(kept) >= limit:
            break
    return [q for q, _ in kept]


class SearchPool:
    def __init__(self) -> None:
        self.results: dict[str, dict] = {}  # url → {title,url,snippet,queries[]}
        self.digests: list[dict] = []  # [{query, text}]
        self.queries_run: list[str] = []
        self.failed_queries: list[dict] = []
        self._lock = threading.Lock()
        self._done: set[str] = set()

    # ---- 단일 쿼리 ------------------------------------------------------------
    def _search_one(self, query: str) -> None:
        res = call_llm(_SYSTEM, f"검색어: {query}", model=FAST_MODEL, max_tokens=900, tools=[WEB_SEARCH_TOOL], timeout=60)
        found: dict[str, dict] = {}
        cite_snips: dict[str, list[str]] = {}
        digest_parts: list[str] = []
        for block in res["content"]:
            btype = block.get("type")
            if btype == "web_search_tool_result":
                content = block.get("content")
                if not isinstance(content, list):  # 오류 객체
                    code = content.get("error_code") if isinstance(content, dict) else "unknown"
                    raise RuntimeError(f"web_search 오류: {code}")
                for item in content:
                    url = item.get("url")
                    if url:
                        found[url] = {"title": item.get("title") or url, "url": url}
            elif btype == "text":
                digest_parts.append(block.get("text", ""))
                for cite in block.get("citations") or []:
                    url, text = cite.get("url"), (cite.get("cited_text") or "").strip()
                    if url and text:
                        cite_snips.setdefault(url, []).append(text)
                        found.setdefault(url, {"title": cite.get("title") or url, "url": url})
        with self._lock:
            for url, info in found.items():
                snippet = " … ".join(dict.fromkeys(cite_snips.get(url, [])))[:SNIPPET_MAX]
                cur = self.results.setdefault(url, {**info, "snippet": "", "queries": []})
                if snippet and not cur["snippet"]:
                    cur["snippet"] = snippet
                cur["queries"].append(query)
            self.digests.append({"query": query, "text": "".join(digest_parts).strip()})
            self.queries_run.append(query)

    # ---- 일괄 수집 --------------------------------------------------------------
    def collect(self, queries: list[str], emit: Emit = noop_emit, agent_id: str = "market") -> "SearchPool":
        todo = [q for q in dedupe_queries(queries) if q not in self._done]
        self._done.update(todo)  # 같은 쿼리 재검색 금지
        total, finished = len(todo), 0
        lock = threading.Lock()

        def task(q: str) -> None:
            nonlocal finished
            last: Optional[Exception] = None
            for _ in range(2):  # 검색 1회 재시도
                try:
                    self._search_one(q)
                    last = None
                    break
                except Exception as exc:  # noqa: BLE001
                    last = exc
            if last is not None:
                with self._lock:
                    self.failed_queries.append({"query": q, "error": f"{type(last).__name__}: {str(last)[:120]}"})
            with lock:
                finished += 1
                emit(agent_id, "working", f"웹 검색 {finished}/{total}: {q[:24]}")

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            list(ex.map(task, todo))
        return self

    # ---- 조회 ---------------------------------------------------------------
    @property
    def allowed_urls(self) -> set[str]:
        return set(self.results)

    def as_list(self) -> list[dict]:
        """[{title, url, snippet}] — 스니펫이 있는 결과를 앞에 둔다."""
        items = [{"title": r["title"], "url": r["url"], "snippet": r["snippet"]} for r in self.results.values()]
        return sorted(items, key=lambda r: (not r["snippet"],))

    def to_prompt_block(self, max_results: int = 30) -> str:
        """에이전트 프롬프트에 넣을 텍스트. 인용 가능한 URL 목록과 검색어별 요약."""
        lines = ["[검색어별 요약]"]
        for d in self.digests:
            lines.append(f"# {d['query']}\n{d['text']}")
        lines.append("\n[출처 후보 목록 — source_url은 반드시 이 목록의 URL만 사용]")
        for i, r in enumerate(self.as_list()[:max_results], 1):
            snip = f" — {r['snippet']}" if r["snippet"] else ""
            lines.append(f"{i}. {r['title']} | {r['url']}{snip}")
        return "\n".join(lines)

    def to_json(self) -> str:
        return json.dumps(
            {"queries_run": self.queries_run, "failed_queries": self.failed_queries, "results": self.as_list(), "digests": self.digests},
            ensure_ascii=False,
            indent=2,
        )
