import { checkInvite, json, readJson } from "@/lib/http";
import * as invite from "@/lib/invite";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const payload = await readJson(req);
  const [code, err] = await checkInvite(req, payload.code);
  if (err) return err;
  return json({
    ok: true,
    remaining: await invite.remaining(code),
    limit: invite.limits()[2],
    lifetime_left: await invite.lifetimeLeft(code),
  });
}
