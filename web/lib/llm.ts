/**
 * Claude 호출 공용 래퍼: temperature 0.2 고정, 동일 입력 해시 캐싱, 토큰 사용량 집계.
 * 에이전트·검색 풀이 모두 이 함수만 거친다. (Anthropic 키 1개로 웹 검색까지 처리한다.)
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { kv } from "./kv";

export const FAST_MODEL = process.env.FAST_MODEL || "claude-haiku-4-5-20251001"; // 정규화·검색 수집
export const SMART_MODEL = process.env.SMART_MODEL || "claude-sonnet-5"; // 시장·재무·실행 분석
// 비평·종합은 순차 구간이라 전체 소요 시간을 좌우한다. 환경변수로 바꿀 수 있다.
// 비평은 형식이 고정된 작업이라 빠른 모델로도 근거 있는 반론이 나온다(약 17초 vs 45초).
// 최종 판정문은 한 줄 카피의 밀도가 중요해 좋은 모델을 쓴다.
export const CRITIC_MODEL = process.env.CRITIC_MODEL || FAST_MODEL;
export const SYNTH_MODEL = process.env.SYNTH_MODEL || SMART_MODEL;
const TEMPERATURE = 0.2;
const CACHE_TTL_SEC = 7 * 24 * 3600;

export const WEB_SEARCH_TOOL: Anthropic.WebSearchTool20250305 = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
  user_location: { type: "approximate", country: "KR", timezone: "Asia/Seoul" },
};

/** max_tokens에 걸려 응답이 중간에 끊긴 경우. */
export class TruncatedResponse extends Error {
  name = "TruncatedResponse";
}

// LLM 응답 블록은 plain JSON으로 다룬다(캐시에 그대로 저장되고 꺼내진다).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Block = Record<string, any>;

let client: Anthropic | null = null;
// temperature를 받지 않는 모델(예: Sonnet 5는 deprecated). 모델별로 기억한다.
const noTemperature = new Set<string>();
export const USAGE = { input_tokens: 0, output_tokens: 0, calls: 0, cache_hits: 0 };

function getClient(): Anthropic {
  if (!client) {
    const key = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!key) throw new Error("ANTHROPIC_API_KEY 환경변수가 없습니다.");
    client = new Anthropic({ apiKey: key, maxRetries: 2 });
  }
  return client;
}

const textOf = (content: Block[]) => content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

export interface CallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: Anthropic.ToolUnion[];
  useCache?: boolean;
  timeoutMs?: number;
  thinking?: Anthropic.ThinkingConfigParam;
  signal?: AbortSignal;
}

export async function callLlm(
  system: string,
  user: string,
  opts: CallOptions = {},
): Promise<{ text: string; content: Block[]; cached: boolean }> {
  const model = opts.model || SMART_MODEL;
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? TEMPERATURE;
  const tools = opts.tools;
  const useCache = (opts.useCache ?? true) && process.env.NO_CACHE !== "1";
  const key =
    "llm:" + createHash("sha256").update(JSON.stringify([model, system, user, temperature, tools ?? null])).digest("hex");

  if (useCache) {
    try {
      const hit = await kv().get<Block[]>(key);
      if (Array.isArray(hit)) {
        USAGE.cache_hits++;
        return { text: textOf(hit), content: hit, cached: true };
      }
    } catch (exc) {
      console.warn("[llm] 캐시 읽기 실패", exc);
    }
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    // Sonnet 5는 기본으로 '생각(thinking)'을 켠다. 정해진 JSON을 채우는 이 작업에서는 생각이 max_tokens를 전부 먹어
    // 본문이 0글자로 잘리고(재무 에이전트 실측: 14,000토큰 소진), 시간·비용만 늘린다. 기본은 끄고 필요할 때만 켠다.
    thinking: opts.thinking ?? { type: "disabled" },
  };
  if (tools) params.tools = tools;
  if (!noTemperature.has(model)) params.temperature = temperature;
  const reqOpts = { timeout: opts.timeoutMs ?? 90_000, signal: opts.signal };

  let resp: Anthropic.Message;
  try {
    resp = await getClient().messages.create(params, reqOpts);
  } catch (exc) {
    if (!(exc instanceof Anthropic.BadRequestError) || !String(exc.message).toLowerCase().includes("temperature")) throw exc;
    noTemperature.add(model); // 이 모델은 이후 temperature 없이 호출한다
    delete params.temperature;
    resp = await getClient().messages.create(params, reqOpts);
  }

  const content = JSON.parse(JSON.stringify(resp.content)) as Block[];
  USAGE.calls++;
  USAGE.input_tokens += resp.usage?.input_tokens ?? 0;
  USAGE.output_tokens += resp.usage?.output_tokens ?? 0;
  if (resp.stop_reason === "max_tokens") {
    // 잘린 JSON은 파싱 단계에서 모호한 오류로 번지므로 여기서 분명히 실패시키고 캐시하지 않는다.
    const kinds = content.map((b) => b.type ?? "?").join(",");
    throw new TruncatedResponse(`max_tokens(${maxTokens}) 초과로 응답이 잘렸습니다(블록: ${kinds}). 상한을 올리거나 출력을 줄이세요.`);
  }
  if (useCache) {
    try {
      await kv().set(key, content, CACHE_TTL_SEC);
    } catch (exc) {
      console.warn("[llm] 캐시 쓰기 실패", exc);
    }
  }
  return { text: textOf(content), content, cached: false };
}
