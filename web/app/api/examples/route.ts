import { EXAMPLE_IDEAS } from "@/lib/agents/normalizer";

export function GET() {
  return Response.json({ examples: EXAMPLE_IDEAS });
}
