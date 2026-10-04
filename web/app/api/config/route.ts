import { required } from "@/lib/invite";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ invite_required: required() });
}
