import type { Metadata, Viewport } from "next";
import "./globals.css";

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%233346d3'/%3E%3Cpath d='M16 6l9.5 6.9-3.6 11.2H10.1L6.5 12.9z' fill='none' stroke='%23fff' stroke-width='2' stroke-linejoin='round'/%3E%3Cpath d='M16 12l4.8 3.5-1.8 5.6h-6l-1.8-5.6z' fill='%23fff'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "사업아이템 분석기",
  description:
    "한 줄 아이디어를 투자 심사역의 시선으로 분석합니다. 시장·수익·실행·리스크를 조사하고 스스로 반박까지 한 리포트를 약 2분 안에 만들어 드려요.",
  icons: { icon: ICON },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f5f2",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
