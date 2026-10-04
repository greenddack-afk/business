"use client";

import { useEffect, useRef } from "react";
import { Chart, Filler, LineElement, PointElement, RadarController, RadialLinearScale, Tooltip } from "chart.js";
import type { Report } from "./format";

Chart.register(RadarController, RadialLinearScale, PointElement, LineElement, Filler, Tooltip);

export const AX: [string, string][] = [
  ["market", "시장성"],
  ["competition", "경쟁"],
  ["execution", "실행"],
  ["profitability", "수익성"],
  ["risk", "리스크"],
];

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export default function Radar({ report }: { report: Report }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let chart: Chart | null = null;

    const draw = () => {
      chart?.destroy();
      const accent = css("--accent"),
        muted = css("--muted"),
        line = css("--line"),
        ink = css("--ink");
      const s = report.scores;
      const fin = AX.map(([k]) => (s[k] ? s[k].score : 0));
      const before = AX.map(([k]) => (s[k] ? (s[k].adjusted_from ?? s[k].score) : 0));
      const anyAdj = before.some((v, i) => v !== fin[i]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sets: any[] = [];
      if (anyAdj) {
        sets.push({
          label: "비평 반영 전",
          data: before,
          borderColor: muted,
          borderDash: [5, 4],
          borderWidth: 1.5,
          backgroundColor: "transparent",
          pointRadius: 0,
          fill: false,
        });
      }
      sets.push({
        label: "최종 점수",
        data: fin,
        borderColor: accent,
        backgroundColor: css("--accent-soft"),
        borderWidth: 2.5,
        fill: true,
        pointBackgroundColor: accent,
        pointBorderColor: css("--panel"),
        pointBorderWidth: 2,
        pointRadius: 4.5,
        pointHoverRadius: 6,
      });
      chart = new Chart(el, {
        type: "radar",
        data: { labels: AX.map((a) => a[1]), datasets: sets },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          aspectRatio: 1,
          animation: matchMedia("(prefers-reduced-motion:reduce)").matches ? false : { duration: 700 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.parsed.r}/10` } },
          },
          scales: {
            r: {
              min: 0,
              max: 10,
              ticks: { stepSize: 2, font: { size: 10 }, color: muted, backdropColor: "transparent" },
              grid: { color: line },
              angleLines: { color: line },
              pointLabels: {
                font: { size: 13.5, weight: 700, family: "Pretendard Variable, Malgun Gothic, sans-serif" },
                color: ink,
              },
            },
          },
        },
      });
    };

    draw();
    // 다크모드 전환 시 차트 색을 다시 그린다
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", draw);
    return () => {
      mq.removeEventListener("change", draw);
      chart?.destroy();
    };
  }, [report]);

  return <canvas ref={ref} role="img" aria-label="5축 사업성 레이더 차트" />;
}
