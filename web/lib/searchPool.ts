/**
 * 공용 검색 풀: 쿼리 중복 제거 · 최대 8회 · 결과 캐시. 검색은 파이프라인에서 이 한 곳에서만 일어난다.
 *
 * 검색 엔진은 Anthropic API 내장 웹 검색 도구(별도 API 키 불필요)이다.
 * 쿼리마다 Haiku가 검색을 1회 수행하고, 인용된 원문 조각(cited_text)을 snippet으로 저장한다.
 */
import { noopEmit, type Emit } from "./agents/base";
import { callLlm, FAST_MODEL, WEB_SEARCH_TOOL } from "./llm";
import { isAbort } from "./schema";

export const MAX_QUERIES = 8;
const SNIPPET_MAX = 400;

const SYSTEM = `너는 사업 조사용 검색 수집기다. 주어진 검색어로 웹 검색을 정확히 1회 수행하고,
결과에서 확인되는 사실 중 **숫자가 있는 것**(시장 규모, 성장률, 가격, 수수료율, 인증 소요 기간, 비용 등)을 우선해
한국어 bullet 3~5개로 정리해라. 확인되지 않은 내용은 쓰지 마라. 응원·군더더기 문장 금지.`;

const tokens = (q: string) => new Set(q.toLowerCase().match(/[가-힣A-Za-z0-9]+/g) ?? []);

/** 공백·구두점 차이와 어순만 다른 쿼리(토큰 집합 Jaccard ≥ 0.8)를 제거하고 상한을 적용한다. */
export function dedupeQueries(queries: string[], limit = MAX_QUERIES): string[] {
  const kept: [string, Set<string>][] = [];
  for (const q of queries) {
    const toks = tokens(q);
    if (!toks.size) continue;
    const dup = kept.some(([, t]) => {
      const inter = [...toks].filter((x) => t.has(x)).length;
      const union = new Set([...toks, ...t]).size;
      return inter / union >= 0.8;
    });
    if (dup) continue;
    kept.push([q.trim(), toks]);
    if (kept.length >= limit) break;
  }
  return kept.map(([q]) => q);
}

interface PoolResult {
  title: string;
  url: string;
  snippet: string;
  queries: string[];
}

export class SearchPool {
  results = new Map<string, PoolResult>(); // url → 결과
  digests: { query: string; text: string }[] = [];
  queriesRun: string[] = [];
  failedQueries: { query: string; error: string }[] = [];
  private done = new Set<string>();

  constructor(private signal?: AbortSignal) {}

  // ---- 단일 쿼리 ------------------------------------------------------------
  async searchOne(query: string): Promise<void> {
    const res = await callLlm(SYSTEM, `검색어: ${query}`, {
      model: FAST_MODEL,
      maxTokens: 900,
      tools: [WEB_SEARCH_TOOL],
      timeoutMs: 60_000,
      signal: this.signal,
    });
    const found = new Map<string, { title: string; url: string }>();
    const citeSnips = new Map<string, string[]>();
    const digestParts: string[] = [];
    for (const block of res.content) {
      if (block.type === "web_search_tool_result") {
        const content = block.content;
        if (!Array.isArray(content)) {
          // 오류 객체 (예: {error_code: "max_uses_exceeded"})
          throw new Error(`web_search 오류: ${content?.error_code ?? "unknown"}`);
        }
        for (const item of content) {
          if (item.url) found.set(item.url, { title: item.title || item.url, url: item.url });
        }
      } else if (block.type === "text") {
        digestParts.push(block.text ?? "");
        for (const cite of block.citations ?? []) {
          const url = cite.url;
          const text = (cite.cited_text ?? "").trim();
          if (url && text) {
            citeSnips.set(url, [...(citeSnips.get(url) ?? []), text]);
            if (!found.has(url)) found.set(url, { title: cite.title || url, url });
          }
        }
      }
    }
    for (const [url, info] of found) {
      const snippet = [...new Set(citeSnips.get(url) ?? [])].join(" … ").slice(0, SNIPPET_MAX);
      let cur = this.results.get(url);
      if (!cur) {
        cur = { ...info, snippet: "", queries: [] };
        this.results.set(url, cur);
      }
      if (snippet && !cur.snippet) cur.snippet = snippet;
      cur.queries.push(query);
    }
    this.digests.push({ query, text: digestParts.join("").trim() });
    this.queriesRun.push(query);
  }

  // ---- 일괄 수집 --------------------------------------------------------------
  async collect(queries: string[], emit: Emit = noopEmit, agentId = "market"): Promise<this> {
    const todo = dedupeQueries(queries).filter((q) => !this.done.has(q));
    todo.forEach((q) => this.done.add(q)); // 같은 쿼리 재검색 금지
    const total = todo.length;
    let finished = 0;

    // 한 배치로 끝내 검색 지연을 줄인다(쿼리 상한 8 = 동시 실행 8).
    await Promise.all(
      todo.map(async (q) => {
        let last: unknown = null;
        for (let i = 0; i < 2; i++) {
          // 검색 1회 재시도
          try {
            await this.searchOne(q);
            last = null;
            break;
          } catch (exc) {
            if (isAbort(exc)) throw exc;
            last = exc;
          }
        }
        if (last) {
          const e = last instanceof Error ? `${last.name}: ${last.message.slice(0, 120)}` : String(last).slice(0, 120);
          this.failedQueries.push({ query: q, error: e });
        }
        finished++;
        emit(agentId, "working", `웹 검색 ${finished}/${total}: ${q.slice(0, 24)}`);
      }),
    );
    return this;
  }

  // ---- 조회 ---------------------------------------------------------------
  get allowedUrls(): Set<string> {
    return new Set(this.results.keys());
  }

  /** [{title, url, snippet}] — 스니펫이 있는 결과를 앞에 둔다. */
  asList(): { title: string; url: string; snippet: string }[] {
    const items = [...this.results.values()].map(({ title, url, snippet }) => ({ title, url, snippet }));
    return [...items.filter((r) => r.snippet), ...items.filter((r) => !r.snippet)];
  }

  /** 에이전트 프롬프트에 넣을 텍스트. 인용 가능한 URL 목록과 검색어별 요약. */
  toPromptBlock(maxResults = 30): string {
    const lines = ["[검색어별 요약]"];
    for (const d of this.digests) lines.push(`# ${d.query}\n${d.text}`);
    lines.push("\n[출처 후보 목록 — source_url은 반드시 이 목록의 URL만 사용]");
    this.asList()
      .slice(0, maxResults)
      .forEach((r, i) => lines.push(`${i + 1}. ${r.title} | ${r.url}${r.snippet ? ` — ${r.snippet}` : ""}`));
    return lines.join("\n");
  }
}
