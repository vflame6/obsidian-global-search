import type { TFile, SearchMatches } from "obsidian";

export function relativeTimeLabel(mtime: number, now: number): string {
  const dayStart = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((dayStart(now) - dayStart(mtime)) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function offsetToLineCh(
  content: string,
  offset: number,
): { line: number; ch: number } {
  const clamped = Math.max(0, Math.min(offset, content.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, ch: clamped - lineStart };
}

export function buildSnippet(
  content: string,
  offset: number,
  length: number,
  maxLen = 80,
): { text: string; matchStart: number; matchLength: number } {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  let lineEnd = content.indexOf("\n", offset);
  if (lineEnd === -1) lineEnd = content.length;

  let line = content.slice(lineStart, lineEnd);
  if (line.endsWith("\r")) line = line.slice(0, -1); // drop trailing CR on CRLF files
  let matchStart = offset - lineStart;

  // Drop leading markdown/list/quote noise (e.g. "## ", "- ", "> ").
  const trimmedLeft = line.replace(/^[\s>#*\-]+/, "");
  const removed = line.length - trimmedLeft.length;
  line = trimmedLeft;
  matchStart = Math.max(0, matchStart - removed);

  if (line.length <= maxLen) {
    return {
      text: line,
      matchStart,
      matchLength: Math.min(length, line.length - matchStart),
    };
  }

  const half = Math.max(0, Math.floor((maxLen - length) / 2));
  const to = Math.min(line.length, Math.max(0, matchStart - half) + maxLen);
  const from = Math.max(0, to - maxLen);
  const prefix = from > 0 ? "… " : "";
  const suffix = to < line.length ? " …" : "";
  const text = prefix + line.slice(from, to) + suffix;
  const windowMatchStart = matchStart - from + prefix.length;
  return {
    text,
    matchStart: windowMatchStart,
    matchLength: Math.min(length, text.length - windowMatchStart),
  };
}

export type FieldType = "title" | "heading" | "content";

export const WEIGHTS: Record<FieldType, number> = {
  title: 3,
  heading: 2,
  content: 1,
};

export interface FieldMatch {
  type: FieldType;
  score: number;
}

export interface SearchHit {
  file: TFile;
  score: number;
  matchType: FieldType;
  titleMatches: SearchMatches | null;
  snippet: string;
  snippetMatches: SearchMatches;
  navLine: number | null;
  navCh: number | null;
  navLength: number;
  isRecent: boolean;
  recentLabel: string;
}

export function rankFields(fields: FieldMatch[]): FieldMatch | null {
  let best: FieldMatch | null = null;
  let bestWeighted = -Infinity;
  for (const f of fields) {
    const weighted = WEIGHTS[f.type] * f.score;
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      best = { type: f.type, score: weighted };
    }
  }
  return best;
}

// Length of an ATX heading's "#"+whitespace prefix (e.g. "## " → 3). Setext
// heading text lines have no prefix, so this returns 0 for them.
export function headingPrefixLength(rawLine: string): number {
  const m = rawLine.match(/^#{1,6}[ \t]+/);
  return m ? m[0].length : 0;
}

export type SearchScope = "filenames" | "content" | "both";

// Which match sources a given scope turns on. "content" relies on heading text
// living in the body (so the content search covers headings); only "both" runs
// the separate metadata-heading pass.
export function enabledFields(scope: SearchScope): {
  title: boolean;
  heading: boolean;
  content: boolean;
} {
  // Fall back to "both" for any unrecognized value so a corrupt or stale stored
  // scope can never silently disable all matching.
  const s = scope === "filenames" || scope === "content" ? scope : "both";
  return {
    title: s === "filenames" || s === "both",
    heading: s === "both",
    content: s === "content" || s === "both",
  };
}
