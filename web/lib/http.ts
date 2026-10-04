/** API 라우트 공용: 접속자 IP, 초대 코드 확인. */
import * as invite from "./invite";

/**
 * 접속자 IP. Vercel은 x-real-ip와 x-forwarded-for 첫 항목에 실제 접속자 IP를 넣고,
 * 접속자가 보낸 같은 이름의 헤더는 덮어쓴다(위조 불가).
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = req.headers.get("x-forwarded-for");
  return xff ? xff.split(",")[0].trim() : "?";
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** [canon 코드, null] 또는 ["", 오류 응답]. */
export async function checkInvite(req: Request, raw: unknown): Promise<[string, Response | null]> {
  const ip = clientIp(req);
  if (await invite.isLocked(ip)) {
    return ["", json({ error: "코드를 여러 번 잘못 입력했어요. 10분 뒤에 다시 시도해 주세요." }, 429)];
  }
  const text = typeof raw === "string" ? raw : "";
  const code = invite.authorize(text);
  if (!code) {
    await invite.recordFailure(ip);
    const msg = !text.trim() ? "초대 코드를 입력해 주세요." : "초대 코드가 올바르지 않아요. 다시 확인해 주세요.";
    return ["", json({ error: msg }, 401)];
  }
  return [code, null];
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}
