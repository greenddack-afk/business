/**
 * POST /api/analyze {idea, invite_code} → 진행 상황을 NDJSON으로 흘려보내고, 마지막 줄에 리포트를 보낸다.
 *
 * 서버리스에서는 응답이 끝나면 실행도 멈추므로, 백그라운드 작업 + 상태 조회 대신
 * 요청 하나 안에서 분석을 끝까지 돌리며 스트리밍한다. 분석은 보통 2~3분 걸린다.
 */
import { validateIdea, EXAMPLE_IDEAS } from "@/lib/agents/normalizer";
import type { AgentStatus } from "@/lib/agents/base";
import { AGENT_CARDS, type AgentCard, type StreamEvent } from "@/lib/cards";
import { checkInvite, json, readJson } from "@/lib/http";
import * as invite from "@/lib/invite";
import { PipelineAbort, runPipeline } from "@/lib/pipeline";
import { AGENT_IDS, isAbort } from "@/lib/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercel Hobby 상한. 분석은 보통 115~185초.

const DEADLINE_MS = 285_000; // 함수가 강제 종료되기 전에 스스로 멈추고 횟수를 돌려준다.
const PING_MS = 10_000; // 검색 구간처럼 이벤트가 뜸할 때 연결이 끊기지 않게 한다.

export async function POST(req: Request) {
  const payload = await readJson(req);
  const idea = String(payload.idea ?? "").trim();

  let code = "";
  if (invite.required()) {
    const [c, err] = await checkInvite(req, payload.invite_code);
    if (err) return err;
    code = c;
  }

  const [ok, reason] = validateIdea(idea);
  if (!ok) return json({ error: reason, examples: EXAMPLE_IDEAS }, 400);

  if (code) {
    const [used, why] = await invite.consume(code);
    if (!used) return json({ error: why }, 429);
  }

  // 부분 실패 시연용 훅. 판매용 서버에서는 꺼 둔다(기본 off). ALLOW_FAIL_INJECTION=1 이면 켜진다.
  let failAgents: string[] = [];
  if (process.env.ALLOW_FAIL_INJECTION === "1" && Array.isArray(payload.fail_agents)) {
    failAgents = payload.fail_agents.filter((a): a is string => (AGENT_IDS as readonly string[]).includes(a as string));
  }

  const abort = new AbortController();
  let deadlineHit = false;
  const startedAt = Date.now();
  const cards: AgentCard[] = AGENT_CARDS.map((c) => ({ ...c, status: "idle", progress_note: "" }));
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (ev: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(ev) + "\n"));
        } catch {
          closed = true;
        }
      };
      const emit = (agentId: string, status: AgentStatus, note = "") => {
        const card = cards.find((c) => c.id === agentId);
        if (!card) return;
        card.status = status;
        card.progress_note = note;
        send({ type: "agents", agents: cards });
      };
      const ping = setInterval(() => send({ type: "ping" }), PING_MS);
      const deadline = setTimeout(() => {
        deadlineHit = true;
        abort.abort();
      }, DEADLINE_MS);
      const onClientGone = () => abort.abort();
      req.signal.addEventListener("abort", onClientGone);

      let failed = true;
      try {
        send({ type: "agents", agents: cards });
        const out = await runPipeline(idea, { emit, signal: abort.signal }, failAgents);
        failed = false;
        for (const c of cards) if (c.status === "working") c.status = "done"; // 끝났는데 working으로 남은 카드 정리
        send({ type: "done", agents: cards, report: out.report, elapsed: Math.round((Date.now() - startedAt) / 100) / 10 });
      } catch (exc) {
        let message = "분석 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.";
        if (exc instanceof PipelineAbort) message = exc.message;
        else if (deadlineHit) message = "분석이 너무 오래 걸려 중단했어요. 사용 횟수는 차감되지 않았어요. 잠시 후 다시 시도해 주세요.";
        else if (!(isAbort(exc) && req.signal.aborted)) console.error("pipeline crashed", exc);
        for (const c of cards) if (c.status === "working") c.status = "failed";
        send({ type: "error", error: message });
      } finally {
        clearInterval(ping);
        clearTimeout(deadline);
        req.signal.removeEventListener("abort", onClientGone);
        if (failed && code) {
          // 서비스 쪽 오류·시간 초과·접속 끊김으로 결과를 못 받았으면 사용 횟수를 돌려준다
          await invite.refund(code).catch((e) => console.error("refund failed", e));
        }
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
