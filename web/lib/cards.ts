/** 진행 화면 카드 규격 — 좌표·크기 고정. 캐릭터 이미지로 교체해도 배치가 유지된다. (서버·화면 공용) */
export const AGENT_CARDS = [
  { id: "normalizer", name: "해석가", role: "아이디어 해석", icon: "🔍", row: 0, col: 1 },
  { id: "market", name: "정찰병", role: "시장 조사", icon: "🔭", row: 1, col: 0 },
  { id: "finance", name: "회계사", role: "수익성 계산", icon: "🧮", row: 1, col: 1 },
  { id: "execution", name: "현장반장", role: "실행가능성", icon: "🦺", row: 1, col: 2 },
  { id: "critic", name: "반대파", role: "반론 제기", icon: "🔻", row: 2, col: 1 },
  { id: "synthesizer", name: "심사위원", role: "최종 종합", icon: "⚖️", row: 3, col: 1 },
] as const;

export type CardStatus = "idle" | "working" | "done" | "failed";

export interface AgentCard {
  id: string;
  name: string;
  role: string;
  icon: string;
  row: number;
  col: number;
  status: CardStatus;
  progress_note: string;
}

/** 분석 스트림(/api/analyze)이 한 줄씩 보내는 이벤트(NDJSON). */
export type StreamEvent =
  | { type: "agents"; agents: AgentCard[] }
  | { type: "done"; agents: AgentCard[]; report: unknown; elapsed: number }
  | { type: "error"; error: string }
  | { type: "ping" };
