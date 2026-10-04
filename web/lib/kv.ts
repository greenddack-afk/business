/**
 * 공유 저장소: Upstash Redis(REST). 서버리스 인스턴스끼리 사용 횟수·LLM 캐시를 함께 본다.
 * 환경변수가 없으면(로컬 개발) 인스턴스 메모리로 대신한다 — 재시작하면 사라진다.
 */
import { Redis } from "@upstash/redis";

export interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec?: number): Promise<void>;
  incrBy(key: string, by: number, ttlSec?: number): Promise<number>;
  hget(key: string, field: string): Promise<number>;
  hincrBy(key: string, field: string, by: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, number>>;
  readonly persistent: boolean;
}

class RedisKv implements Kv {
  readonly persistent = true;
  constructor(private r: Redis) {}
  async get<T>(key: string) {
    return (await this.r.get<T>(key)) ?? null;
  }
  async set(key: string, value: unknown, ttlSec?: number) {
    if (ttlSec) await this.r.set(key, value, { ex: ttlSec });
    else await this.r.set(key, value);
  }
  async incrBy(key: string, by: number, ttlSec?: number) {
    const v = await this.r.incrby(key, by);
    if (ttlSec && v === by) await this.r.expire(key, ttlSec); // 처음 만들어질 때만 만료를 건다
    return v;
  }
  async hget(key: string, field: string) {
    return Number((await this.r.hget<number>(key, field)) ?? 0);
  }
  async hincrBy(key: string, field: string, by: number) {
    return this.r.hincrby(key, field, by);
  }
  async hgetall(key: string) {
    const all = (await this.r.hgetall<Record<string, number>>(key)) ?? {};
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Number(v)]));
  }
}

class MemoryKv implements Kv {
  readonly persistent = false;
  private data = new Map<string, { v: unknown; exp: number }>();
  private live(key: string) {
    const e = this.data.get(key);
    if (e && e.exp && e.exp < Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }
  async get<T>(key: string) {
    return (this.live(key)?.v as T) ?? null;
  }
  async set(key: string, value: unknown, ttlSec?: number) {
    this.data.set(key, { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }
  async incrBy(key: string, by: number, ttlSec?: number) {
    const e = this.live(key);
    const v = Number(e?.v ?? 0) + by;
    this.data.set(key, { v, exp: e?.exp || (ttlSec ? Date.now() + ttlSec * 1000 : 0) });
    return v;
  }
  private hash(key: string) {
    const e = this.live(key);
    if (e) return e.v as Record<string, number>;
    const h: Record<string, number> = {};
    this.data.set(key, { v: h, exp: 0 });
    return h;
  }
  async hget(key: string, field: string) {
    return this.hash(key)[field] ?? 0;
  }
  async hincrBy(key: string, field: string, by: number) {
    const h = this.hash(key);
    h[field] = (h[field] ?? 0) + by;
    return h[field];
  }
  async hgetall(key: string) {
    return { ...this.hash(key) };
  }
}

let instance: Kv | null = null;

export function kv(): Kv {
  if (instance) return instance;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (url && token) {
    instance = new RedisKv(new Redis({ url, token }));
  } else {
    if (process.env.VERCEL) {
      console.warn("[kv] Redis 환경변수가 없어 메모리 저장소를 씁니다. 사용 횟수 제한이 인스턴스마다 따로 셉니다.");
    }
    instance = new MemoryKv();
  }
  return instance;
}

/** 테스트용: 메모리 저장소로 초기화한다. */
export function resetKvForTests(): void {
  instance = new MemoryKv();
}
