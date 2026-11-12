import type { ReactNode } from "react";
import { Clock } from "lucide-react";
import { useStats } from "@texthooker/hooks/useStats";
import { getSettings } from "@texthooker/lib/settings";
import { useLanguage } from "../../bridge/useLanguage";

function formatTime(ms: number): string {
  if (ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatSpeed(chars: number, ms: number): string {
  if (ms < 1000) return "—";
  const hours = ms / 3_600_000;
  if (hours <= 0) return "—";
  const cph = Math.round(chars / hours);
  return formatNumber(cph);
}

interface Props {
  lineCount: number;
}

/** Compact reading-stats strip for the Log footer: UI face, tabular numerals. */
export function StatsFooter({ lineCount }: Props) {
  const { stats, elapsedMs } = useStats();
  const s = getSettings();
  // A language that spaces its words is read in words (counted since it was chosen); stats with
  // no word count yet, and Japanese, in characters.
  const [language] = useLanguage();
  const inWords = language.spaces && stats.totalWords !== undefined;
  const amount = inWords ? (stats.totalWords ?? 0) : stats.totalChars;
  const unit = inWords ? "words" : "chars";

  const stat = (key: string, value: string, unit?: string, icon?: ReactNode) => (
    <span key={key} className="log-stat">
      {icon}
      <span className="log-stat-value">{value}</span>
      {unit ? <span>{unit}</span> : null}
    </span>
  );

  const bits: ReactNode[] = [];
  if (s.statsShowTime)
    bits.push(
      stat("time", formatTime(elapsedMs), undefined, (
        <Clock aria-label="Reading time" />
      )),
    );
  if (s.statsShowLines)
    bits.push(
      stat("lines", formatNumber(lineCount), lineCount === 1 ? "line" : "lines"),
    );
  if (s.statsShowChars)
    bits.push(stat("chars", formatNumber(amount), unit));
  if (s.statsShowSpeed)
    bits.push(
      stat("speed", formatSpeed(amount, elapsedMs), `${unit}/h`),
    );

  return <span className="log-stats k-num">{bits}</span>;
}
