import { beforeEach, describe, expect, it } from "vitest";
import * as invite from "@/lib/invite";
import { resetKvForTests } from "@/lib/kv";

const CODE = "ABCD-EFGH-JKMN";

beforeEach(() => {
  resetKvForTests();
  process.env.INVITE_CODES = `${CODE}:시범1,PQRS-TUVW-XYZ2`;
  delete process.env.REQUIRE_INVITE;
  delete process.env.DAILY_LIMIT_PER_CODE;
  delete process.env.DAILY_LIMIT_TOTAL;
  delete process.env.LIFETIME_LIMIT_PER_CODE;
});

describe("초대 코드", () => {
  it("대소문자·하이픈·공백을 무시하고 인증", () => {
    expect(invite.authorize("abcd efgh jkmn")).toBe("ABCDEFGHJKMN");
    expect(invite.authorize("ABCD-EFGH-XXXX")).toBeNull();
    expect(invite.authorize("")).toBeNull();
  });
  it("코드가 있으면 필수, 없어도 REQUIRE_INVITE=1이면 필수(전부 거부)", () => {
    expect(invite.required()).toBe(true);
    process.env.INVITE_CODES = "";
    expect(invite.required()).toBe(false);
    process.env.REQUIRE_INVITE = "1";
    expect(invite.required()).toBe(true);
    expect(invite.authorize(CODE)).toBeNull();
  });
  it("평생 한도 5회", async () => {
    const c = invite.authorize(CODE)!;
    for (let i = 0; i < 5; i++) expect((await invite.consume(c))[0]).toBe(true);
    const [ok, why] = await invite.consume(c);
    expect(ok).toBe(false);
    expect(why).toContain("5회");
    expect(await invite.remaining(c)).toBe(0);
    expect(await invite.lifetimeLeft(c)).toBe(0);
  });
  it("서비스 전체 하루 한도", async () => {
    process.env.DAILY_LIMIT_TOTAL = "2";
    const a = invite.authorize(CODE)!;
    const b = invite.authorize("PQRS-TUVW-XYZ2")!;
    expect((await invite.consume(a))[0]).toBe(true);
    expect((await invite.consume(b))[0]).toBe(true);
    const [ok, why] = await invite.consume(a);
    expect(ok).toBe(false);
    expect(why).toContain("전체");
    // 실패한 시도는 평생 횟수를 깎지 않는다(되돌림)
    expect(await invite.lifetimeLeft(a)).toBe(4);
  });
  it("환불하면 횟수가 돌아온다", async () => {
    const c = invite.authorize(CODE)!;
    await invite.consume(c);
    expect(await invite.lifetimeLeft(c)).toBe(4);
    await invite.refund(c);
    expect(await invite.lifetimeLeft(c)).toBe(5);
    expect(await invite.remaining(c)).toBe(5);
  });
  it("같은 IP에서 5번 틀리면 잠긴다", async () => {
    for (let i = 0; i < 4; i++) await invite.recordFailure("1.2.3.4");
    expect(await invite.isLocked("1.2.3.4")).toBe(false);
    await invite.recordFailure("1.2.3.4");
    expect(await invite.isLocked("1.2.3.4")).toBe(true);
    expect(await invite.isLocked("5.6.7.8")).toBe(false);
  });
});
