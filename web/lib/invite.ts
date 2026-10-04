/**
 * 초대 코드 · 사용 횟수 제한 (비공개 시범 운영용).
 *
 * - 코드가 하나라도 등록돼 있으면 분석은 유효한 초대 코드가 있어야만 실행된다.
 *   코드가 하나도 없으면 열린 상태(개발용)다. 배포 서버에서는 REQUIRE_INVITE=1 을 켜 두면
 *   코드 설정이 빠졌을 때도 '전부 거부'로 닫힌다(fail closed).
 * - 코드 출처: 환경변수 INVITE_CODES("코드:메모,코드:메모").
 * - 횟수 제한 3종 (0으로 두면 그 제한은 끔):
 *     LIFETIME_LIMIT_PER_CODE  코드당 평생 총 횟수 (기본 5)  ← 날짜와 무관하게 누적
 *     DAILY_LIMIT_PER_CODE     코드당 하루 횟수 (기본 0=끔, 한국시간 기준)
 *     DAILY_LIMIT_TOTAL        서비스 전체 하루 횟수 (기본 30) ← 비용 상한: 30회 × 약 $0.9 ≈ 하루 최대 $27
 * - 사용 횟수는 공유 저장소(Upstash Redis)에 둔다. 서버리스 인스턴스가 여러 개여도 같은 숫자를 본다.
 * - 코드 무차별 대입 방어: 같은 IP에서 10분 안에 5번 틀리면 10분간 잠근다.
 * - 분석이 서비스 오류로 실패하면 사용 횟수를 돌려준다(refund).
 */
import { timingSafeEqual } from "node:crypto";
import { todayKst } from "./agents/base";
import { kv } from "./kv";

const LOCK_AFTER = 5;
const LOCK_WINDOW_SEC = 600; // 5번 실패 / 10분
const DAY_TTL_SEC = 2 * 24 * 3600;
const LIFETIME_KEY = "invite:lifetime";

/** 대소문자·하이픈·공백 차이를 무시한 비교용 형태. */
export const canon = (code: string | null | undefined) => (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** {canon: {code: 표시용, label: 메모}} */
export function loadCodes(): Map<string, { code: string; label: string }> {
  const found = new Map<string, { code: string; label: string }>();
  for (const part of (process.env.INVITE_CODES ?? "").split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf(":");
    const raw = i === -1 ? part : part.slice(0, i);
    const label = i === -1 ? "" : part.slice(i + 1);
    const c = canon(raw);
    if (c.length >= 6) found.set(c, { code: raw.trim().toUpperCase(), label: label.trim() });
  }
  return found;
}

export const required = () => process.env.REQUIRE_INVITE === "1" || loadCodes().size > 0;

/** [코드당 하루, 전체 하루, 코드당 평생]. 0이면 그 제한은 끈다. */
export function limits(): [number, number, number] {
  const num = (v: string | undefined, d: number) => (v ? parseInt(v, 10) || 0 : d);
  return [num(process.env.DAILY_LIMIT_PER_CODE, 0), num(process.env.DAILY_LIMIT_TOTAL, 30), num(process.env.LIFETIME_LIMIT_PER_CODE, 5)];
}

// ---------------------------------------------------------------- 무차별 대입 방어
export async function isLocked(ip: string): Promise<boolean> {
  return Number((await kv().get<number>(`invite:fail:${ip}`)) ?? 0) >= LOCK_AFTER;
}

export async function recordFailure(ip: string): Promise<void> {
  await kv().incrBy(`invite:fail:${ip}`, 1, LOCK_WINDOW_SEC);
}

// ---------------------------------------------------------------- 인증
/** 유효하면 canon 코드를 돌려준다. 아니면 null. (상수 시간 비교) */
export function authorize(code: string | null | undefined): string | null {
  const given = canon(code);
  if (!given) return null;
  let match: string | null = null;
  const g = Buffer.from(given);
  for (const c of loadCodes().keys()) {
    const b = Buffer.from(c);
    if (b.length === g.length && timingSafeEqual(b, g)) match = c;
  }
  return match;
}

// ---------------------------------------------------------------- 사용량
const dayKey = (suffix: string) => `invite:day:${todayKst()}:${suffix}`;

async function usedToday(codeCanon: string): Promise<[number, number]> {
  const store = kv();
  const total = Number((await store.get<number>(dayKey("total"))) ?? 0);
  const mine = Number((await store.get<number>(dayKey(`code:${codeCanon}`))) ?? 0);
  return [total, mine];
}

/** 지금 이 코드로 쓸 수 있는 횟수(적용 중인 제한 중 가장 빡빡한 것 기준). */
export async function remaining(codeCanon: string): Promise<number> {
  const [per, total, life] = limits();
  const [usedTotal, usedMine] = await usedToday(codeCanon);
  const options = [total - usedTotal];
  if (per > 0) options.push(per - usedMine);
  if (life > 0) options.push(life - (await kv().hget(LIFETIME_KEY, codeCanon)));
  return Math.max(0, Math.min(...options));
}

/** 평생 한도에서 남은 횟수. 평생 제한을 껐으면 null. */
export async function lifetimeLeft(codeCanon: string): Promise<number | null> {
  const life = limits()[2];
  if (life <= 0) return null;
  return Math.max(0, life - (await kv().hget(LIFETIME_KEY, codeCanon)));
}

/**
 * 횟수를 1 차감한다. [성공 여부, 실패 사유 메시지]
 * 먼저 올리고 한도를 넘었으면 되돌린다 — 동시에 여러 요청이 와도 한도를 넘겨 쓰지 않는다.
 */
export async function consume(codeCanon: string): Promise<[boolean, string]> {
  const [per, total, life] = limits();
  const store = kv();
  const undo: (() => Promise<unknown>)[] = [];
  const rollback = async () => {
    for (const f of undo.reverse()) await f();
  };

  const lt = await store.hincrBy(LIFETIME_KEY, codeCanon, 1);
  undo.push(() => store.hincrBy(LIFETIME_KEY, codeCanon, -1));
  if (life > 0 && lt > life) {
    await rollback();
    return [false, `이 초대 코드의 사용 횟수(${life}회)를 모두 썼어요.`];
  }
  const tot = await store.incrBy(dayKey("total"), 1, DAY_TTL_SEC);
  undo.push(() => store.incrBy(dayKey("total"), -1));
  if (tot > total) {
    await rollback();
    return [false, "오늘 서비스 전체 사용량이 가득 찼어요. 내일 다시 이용해 주세요."];
  }
  const mine = await store.incrBy(dayKey(`code:${codeCanon}`), 1, DAY_TTL_SEC);
  undo.push(() => store.incrBy(dayKey(`code:${codeCanon}`), -1));
  if (per > 0 && mine > per) {
    await rollback();
    return [false, `이 초대 코드의 오늘 사용 횟수(${per}회)를 모두 썼어요. 내일 다시 이용해 주세요.`];
  }
  return [true, ""];
}

/** 서비스 오류로 결과를 못 줬을 때 횟수를 돌려준다(평생 횟수 포함). */
export async function refund(codeCanon: string): Promise<void> {
  const store = kv();
  if (Number((await store.get<number>(dayKey(`code:${codeCanon}`))) ?? 0) > 0) {
    await store.incrBy(dayKey(`code:${codeCanon}`), -1);
    if (Number((await store.get<number>(dayKey("total"))) ?? 0) > 0) await store.incrBy(dayKey("total"), -1);
  }
  if ((await store.hget(LIFETIME_KEY, codeCanon)) > 0) await store.hincrBy(LIFETIME_KEY, codeCanon, -1);
}
