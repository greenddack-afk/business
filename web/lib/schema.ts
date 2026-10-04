/**
 * 리포트 JSON 스키마 + 검증·재시도 로직.
 *
 * - 에이전트 6종의 출력 스키마를 한곳에서 정의한다.
 * - 모든 숫자는 {value, unit, source_url, confidence} 형태이며,
 *   source_url이 비었거나 검색 풀에 없는 URL이면 confidence를 "estimated"로 강제한다.
 * - runWithRetry: 검증 실패 시 1회 재시도, 2회 실패하면 ok=false로 돌려준다.
 *   호출자(pipeline.ts)는 이 경우 해당 섹션만 비우고 degraded_sections에 추가한 뒤 계속 진행한다.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

export const AGENT_IDS = ["normalizer", "market", "finance", "execution", "critic", "synthesizer"] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export const AXES = ["market", "competition", "execution", "profitability", "risk"] as const;
export type Axis = (typeof AXES)[number];
export const AXIS_LABELS: Record<Axis, string> = {
  market: "시장성",
  competition: "경쟁",
  execution: "실행",
  profitability: "수익성",
  risk: "리스크",
};
export const INDUSTRY_CODES = [
  "manufacturing",
  "commerce",
  "saas_software",
  "offline_store",
  "service_agency",
  "content_media",
  "platform_marketplace",
  "education_coaching",
] as const;
export const INTERPRETATIONS = ["default", "oem_import", "own_manufacturing"] as const;
export const GRADES = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"] as const;
export const LEVELS = ["상", "중", "하"] as const;
export const OBJECTION_ANGLES = ["이미 존재한다", "숨은 비용", "고객이 돈을 안 낸다"] as const;
// 보고서에서 통째로 비워질 수 있는 섹션(= degraded_sections에 들어갈 수 있는 이름)
export const DEGRADABLE_SECTIONS = ["market", "roi", "feasibility", "critique", "roadmap"] as const;

// LLM이 만든 JSON은 구조가 깊고 동적이라 느슨한 타입으로 다룬다. 구조 보장은 스키마 검증이 맡는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
type Schema = Record<string, unknown>;

const STR: Schema = { type: "string", minLength: 1 };
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });

function obj(props: Record<string, Schema>, optional: string[] = []): Schema {
  return { type: "object", properties: props, required: Object.keys(props).filter((k) => !optional.includes(k)) };
}

const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });

const NUMBER = obj({
  value: { type: "number" },
  unit: STR,
  source_url: { type: "string" },
  confidence: { enum: ["sourced", "estimated"] },
});

const SCORE = obj({
  score: { type: "integer", minimum: 0, maximum: 10 }, // 점수를 먼저 확정
  rubric_ref: STR, // 예: "market:7-8"
  rationale: STR, // 설명은 점수 뒤에
});

const SCORE_ADJUSTED = obj({
  score: { type: "integer", minimum: 0, maximum: 10 },
  rubric_ref: STR,
  rationale: STR,
  adjusted_from: { type: ["integer", "null"], minimum: 0, maximum: 10 },
});

const ASSUMPTION = obj({ key: STR, value: STR, reason: STR });

const DEFS = { number: NUMBER, score: SCORE, score_adjusted: SCORE_ADJUSTED, assumption: ASSUMPTION };
const withDefs = (s: Schema): Schema => ({ ...s, $defs: DEFS });

// ---------------------------------------------------------------- 에이전트별 본문 스키마
const NORMALIZER_PROPS: Record<string, Schema> = {
  product: STR,
  target: STR,
  differentiator: STR,
  industry_code: { enum: [...INDUSTRY_CODES] },
  industry_confidence: { type: "number", minimum: 0, maximum: 1 },
  interpretation: { enum: [...INTERPRETATIONS] },
  alternative_interpretation: STR,
  assumptions: { type: "array", minItems: 3, items: ref("assumption") },
  queries: { type: "array", minItems: 6, maxItems: 9, items: { type: "string", minLength: 2 } },
};

const MARKET_BODY: Record<string, Schema> = {
  summary: STR,
  size: ref("number"),
  growth: ref("number"),
  competition_level: { enum: [...LEVELS] }, // 상 = 경쟁 강함
  competitors: {
    type: "array",
    maxItems: 6,
    items: obj({ name: STR, positioning: STR, url: { type: "string" }, note: { type: "string" } }),
  },
  trends: { type: "array", minItems: 3, maxItems: 3, items: STR },
};

const LEVEL_BLOCK = obj(
  {
    level: { enum: [...LEVELS] }, // 상 = 부담·위험 큼
    summary: STR,
    detail: { type: "string" },
    lead_time_weeks: ref("number"),
  },
  ["lead_time_weeks"],
);

const EXECUTION_BODY: Record<string, Schema> = {
  summary: STR,
  tech: LEVEL_BLOCK,
  capital: LEVEL_BLOCK,
  people: LEVEL_BLOCK,
  regulation: LEVEL_BLOCK,
};

const SCENARIO = obj({ monthly_units: ref("number"), cumulative_profit_12m: ref("number"), note: { type: "string" } });

const FINANCE_BODY: Record<string, Schema> = {
  summary: STR,
  initial_investment: { type: "array", minItems: 1, items: obj({ item: STR, amount: ref("number") }) },
  total_initial_investment: ref("number"),
  fixed_cost_monthly: ref("number"),
  unit_economics: obj({
    price: ref("number"),
    unit_cost: ref("number"),
    variable_cost: ref("number"),
    contribution_margin: ref("number"),
  }),
  break_even: obj({ units_per_month: ref("number"), payback_months: ref("number") }),
  scenarios: obj({ conservative: SCENARIO, base: SCENARIO, optimistic: SCENARIO }),
};

function agentSchema(body: Record<string, Schema>, axes: string[]): Schema {
  const scores = obj(Object.fromEntries(axes.map((a) => [a, ref("score")])));
  return withDefs(obj({ scores, ...body }));
}

const CRITIC_BODY = obj({
  objections: {
    type: "array",
    minItems: 3,
    maxItems: 3,
    items: obj({ angle: { enum: [...OBJECTION_ANGLES] }, claim: STR, evidence: STR, evidence_url: { type: "string" } }),
  },
  adjustments: {
    type: "array",
    maxItems: AXES.length,
    items: obj({
      axis: { enum: [...AXES] },
      delta: { type: "integer", minimum: -2, maximum: 0 },
      reason: STR,
      evidence_url: { type: "string" },
    }),
  },
});

const ROADMAP_STAGE = obj({
  stage: STR,
  period: STR,
  actions: { type: "array", minItems: 1, items: STR },
  cost: ref("number"),
  gate_condition: STR,
});

const REPORT_SCHEMA = withDefs(
  obj({
    idea_raw: STR,
    normalized: obj({
      product: STR,
      target: STR,
      differentiator: STR,
      industry_code: { enum: [...INDUSTRY_CODES] },
      industry_confidence: { type: "number", minimum: 0, maximum: 1 },
      interpretation: { enum: [...INTERPRETATIONS] },
      alternative_interpretation: STR,
    }),
    verdict: obj({ grade: { enum: [...GRADES] }, decision: STR, one_liner: STR }),
    assumptions: { type: "array", minItems: 1, items: ref("assumption") },
    scores: obj(Object.fromEntries(AXES.map((a) => [a, nullable(ref("score_adjusted"))]))),
    market: nullable(obj(MARKET_BODY)),
    roi: nullable(obj(FINANCE_BODY)),
    feasibility: nullable(obj(EXECUTION_BODY)),
    critique: nullable(CRITIC_BODY),
    // 3단계가 원칙이나, Synthesizer 실패 시 빈 배열 + degraded_sections["roadmap"]으로 진행한다.
    roadmap: { type: "array", maxItems: 3, items: ROADMAP_STAGE },
    sources: {
      type: "array",
      items: obj({ title: { type: "string" }, url: STR, used_for: { type: "string" } }),
    },
    degraded_sections: { type: "array", items: { enum: [...DEGRADABLE_SECTIONS] } },
  }),
);

// Synthesizer가 LLM에게 실제로 시키는 것은 판정문·가정·로드맵뿐이다.
// (시장·ROI·실행 섹션은 이미 검증된 결과를 코드가 그대로 옮기고, 등급은 코드가 계산한다.)
const SYNTH_LLM_SCHEMA = withDefs(
  obj({
    one_liner: STR,
    assumptions: { type: "array", minItems: 3, maxItems: 6, items: ref("assumption") },
    roadmap: { type: "array", minItems: 3, maxItems: 3, items: ROADMAP_STAGE },
  }),
);

export const SCHEMAS: Record<string, Schema> = {
  normalizer: withDefs(obj(NORMALIZER_PROPS)),
  market: agentSchema(MARKET_BODY, ["market", "competition"]),
  finance: agentSchema(FINANCE_BODY, ["profitability"]),
  execution: agentSchema(EXECUTION_BODY, ["execution", "risk"]),
  critic: withDefs(CRITIC_BODY),
  synthesizer: REPORT_SCHEMA,
  // agent_id 6종 외에 내부적으로만 쓰는 스키마
  synthesizer_llm: SYNTH_LLM_SCHEMA,
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

function validator(agentId: string): ValidateFunction {
  let fn = compiled.get(agentId);
  if (!fn) {
    const target = SCHEMAS[agentId];
    if (!target) throw new Error(`알 수 없는 agent_id: ${agentId}`);
    fn = ajv.compile(target);
    compiled.set(agentId, fn);
  }
  return fn;
}

// ---------------------------------------------------------------- JSON 추출·숫자 정규화
const FENCE = /^\s*```[a-zA-Z]*\s*|\s*```\s*$/g;

/** LLM 출력에서 JSON을 꺼낸다. 마크다운 백틱·앞뒤 잡담이 붙어도 복구한다. */
export function extractJson(text: string): Json {
  if (typeof text !== "string" || !text.trim()) throw new Error("빈 응답");
  const cleaned = text.trim().replace(FENCE, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 아래에서 중괄호 범위로 재시도 */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("JSON 객체를 찾을 수 없음");
  return JSON.parse(cleaned.slice(start, end + 1));
}

export const normUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

const isPlainObject = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 숫자 객체를 정규화한다(원본은 수정하지 않고 복사본 반환).
 * - source_url이 null/비어 있으면 "" 로 통일
 * - allowedUrls가 주어지면, 그 목록에 없는 URL(= 모델이 지어낸 링크)은 제거
 * - source_url이 비면 confidence를 "estimated"로 강제, 있으면 "sourced"
 * - "3,200" 같은 문자열 숫자는 number로 변환
 */
export function normalizeNumbers<T = Json>(data: T, allowedUrls?: Iterable<string> | null): T {
  const allowed = allowedUrls ? new Set([...allowedUrls].map(normUrl)) : null;

  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isPlainObject(node)) return node;
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v);
    if ("value" in out && "unit" in out) {
      let url = typeof out.source_url === "string" ? out.source_url.trim() : "";
      if (url && allowed && !allowed.has(normUrl(url))) url = "";
      out.source_url = url;
      out.confidence = url ? "sourced" : "estimated";
      if (typeof out.value === "string") {
        const s = out.value.replace(/,/g, "").trim();
        const n = Number(s);
        if (s && Number.isFinite(n)) out.value = n;
      }
    }
    return out;
  };

  return walk(data);
}

// ---------------------------------------------------------------- 검증
function extraChecks(agentId: string, data: Json): string[] {
  const errors: string[] = [];
  if (agentId === "critic") {
    const angles: string[] = (data.objections ?? []).map((o: Json) => o.angle);
    if ([...angles].sort().join("|") !== [...OBJECTION_ANGLES].sort().join("|")) {
      errors.push(`objections: 반론 각도는 ${JSON.stringify(OBJECTION_ANGLES)} 3종을 한 번씩 써야 한다 (받은 값: ${JSON.stringify(angles)})`);
    }
    const axes: string[] = (data.adjustments ?? []).map((a: Json) => a.axis);
    if (axes.length !== new Set(axes).size) errors.push("adjustments: 같은 축을 두 번 조정할 수 없다");
  }
  if (agentId === "synthesizer") {
    const degraded = new Set(data.degraded_sections ?? []);
    for (const key of DEGRADABLE_SECTIONS) {
      const v = data[key];
      const empty = v == null || (key === "roadmap" && !(Array.isArray(v) && v.length));
      if (empty && !degraded.has(key)) errors.push(`${key}: 값이 비면 degraded_sections에 '${key}'를 넣어야 한다`);
    }
    if (Array.isArray(data.roadmap) && data.roadmap.length && data.roadmap.length !== 3) {
      errors.push("roadmap: 3단계이거나 빈 배열이어야 한다");
    }
  }
  return errors;
}

/** 스키마 위반 메시지 목록을 반환한다. 빈 배열이면 통과. */
export function validate(agentId: string, data: Json): string[] {
  const fn = validator(agentId);
  if (!isPlainObject(data)) return ["최상위 값이 JSON 객체가 아니다"];
  if (fn(data)) return extraChecks(agentId, data);
  return (fn.errors ?? []).map((e) => {
    const path = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || "(root)";
    const detail = e.params && "allowedValues" in e.params ? ` ${JSON.stringify(e.params.allowedValues)}` : "";
    return `${path}: ${(e.message ?? "invalid") + detail}`.slice(0, 200);
  });
}

// ---------------------------------------------------------------- 재시도
export interface AgentResult {
  agentId: string;
  ok: boolean;
  data: Json | null;
  errors: string[];
  attempts: number;
  raw: string;
  history: string[][]; // 시도별 오류(성공해도 남는다 → 재시도 원인 추적용)
}

const errText = (exc: unknown) => (exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc));

/**
 * callFn(feedback) -> 원문 텍스트. 실패하면 오류 피드백을 붙여 maxRetries번 재시도한다.
 * API 예외·JSON 파싱 실패·스키마 위반은 모두 '실패한 시도'로 센다.
 * 최종 실패 시 ok=false를 돌려주며 예외를 던지지 않는다(전체 중단 금지). 단, 중단 신호(AbortError)는 그대로 던진다.
 */
export async function runWithRetry(
  agentId: string,
  callFn: (feedback: string | null) => Promise<string>,
  opts: { allowedUrls?: Iterable<string> | null; maxRetries?: number; checks?: (data: Json) => string[] } = {},
): Promise<AgentResult> {
  const { allowedUrls = null, maxRetries = 1, checks } = opts;
  let feedback: string | null = null;
  let errors: string[] = [];
  const history: string[][] = [];
  let raw = "";
  let attempts = 0;
  for (attempts = 1; attempts <= maxRetries + 1; attempts++) {
    let data: Json = null;
    try {
      raw = await callFn(feedback);
      data = normalizeNumbers(extractJson(raw), allowedUrls);
      errors = validate(agentId, data);
      if (!errors.length && checks) errors = checks(data); // 스키마 밖의 도메인 검증(단위·항목 수 등)
    } catch (exc) {
      if (isAbort(exc)) throw exc;
      errors = [errText(exc)];
    }
    history.push(errors);
    if (!errors.length) return { agentId, ok: true, data, errors: [], attempts, raw, history };
    feedback = "직전 출력이 아래 오류로 거부되었다. 설명 없이 수정된 JSON 객체만 다시 출력하라.\n- " + errors.slice(0, 8).join("\n- ");
  }
  return { agentId, ok: false, data: null, errors, attempts: attempts - 1, raw, history };
}

export function isAbort(exc: unknown): boolean {
  return exc instanceof Error && (exc.name === "AbortError" || exc.name === "APIUserAbortError");
}
