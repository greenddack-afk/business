import type { ReactNode } from "react";

// 리포트 JSON은 서버 스키마 검증을 통과한 구조라 화면에서는 느슨한 타입으로 읽는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Report = any;

export const fmt = (v: number) => Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
export const safeUrl = (u: unknown) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");

/** 숫자: 출처 있으면 링크, 없으면 회색 점선 + [추정치] */
export function Num({ n, sign = false, unit = true }: { n: Report; sign?: boolean; unit?: boolean }): ReactNode {
  if (!n || typeof n.value !== "number") return <span className="est">데이터 없음</span>;
  const txt = `${sign && n.value > 0 ? "+" : ""}${fmt(n.value)}${unit ? " " + (n.unit ?? "") : ""}`;
  const u = safeUrl(n.source_url);
  if (u) {
    return (
      <>
        {txt}
        <a className="src" href={u} target="_blank" rel="noopener noreferrer">
          출처
        </a>
      </>
    );
  }
  return (
    <>
      <span className="est">{txt}</span>
      <span className="badge-est">추정치</span>
    </>
  );
}

export function ExtLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
