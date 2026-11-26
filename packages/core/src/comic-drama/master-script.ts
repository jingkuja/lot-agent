import { COMIC_SCRIPT_MAX_CHARS } from "./director.js";

export type ParsedComicMasterEpisode = {
  episodeNo: number;
  title: string;
  heading: string;
  content: string;
  preview: string;
  truncated: boolean;
};

export type ResolvedComicEpisodeScript = {
  matched: "episode" | "whole_fallback" | "none";
  episodeNo: number;
  title: string;
  content: string;
  truncated: boolean;
  totalParsedEpisodes: number;
};

const FULLWIDTH_DIGITS: Record<string, string> = {
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
  "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
};

const CHINESE_DIGITS: Record<string, number> = {
  "零": 0, "〇": 0, "一": 1, "壹": 1, "二": 2, "两": 2, "兩": 2, "贰": 2, "貳": 2,
  "三": 3, "叁": 3, "參": 3, "四": 4, "肆": 4, "五": 5, "伍": 5,
  "六": 6, "陆": 6, "陸": 6, "七": 7, "柒": 7, "八": 8, "捌": 8, "九": 9, "玖": 9,
};

const CHINESE_UNITS: Record<string, number> = {
  "十": 10, "拾": 10, "百": 100, "佰": 100, "千": 1000, "仟": 1000,
};

function sliceSafe(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/u, ""),
    truncated: true,
  };
}

function parseEpisodeNumberToken(raw: string): number | null {
  const token = raw.trim().replace(/[０-９]/g, ch => FULLWIDTH_DIGITS[ch] ?? ch);
  if (!token) return null;
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return Number.isInteger(n) && n >= 1 && n <= 9999 ? n : null;
  }

  let total = 0;
  let currentDigit: number | null = null;
  let lastUnit = Infinity;
  let sawNonZero = false;

  for (const ch of token) {
    if (ch in CHINESE_DIGITS) {
      const digit = CHINESE_DIGITS[ch]!;
      if (digit === 0) {
        if (currentDigit !== null) return null;
        currentDigit = 0;
        continue;
      }
      if (currentDigit !== null && currentDigit !== 0) return null;
      currentDigit = digit;
      sawNonZero = true;
      continue;
    }
    if (ch in CHINESE_UNITS) {
      const unit = CHINESE_UNITS[ch]!;
      if (unit >= lastUnit) return null;
      if (currentDigit === 0) return null;
      const multiplier = currentDigit === null ? (unit === 10 && total === 0 ? 1 : null) : currentDigit;
      if (multiplier === null) return null;
      total += multiplier * unit;
      currentDigit = null;
      lastUnit = unit;
      sawNonZero = true;
      continue;
    }
    return null;
  }

  if (currentDigit !== null) {
    if (currentDigit === 0) return null;
    total += currentDigit;
  }
  if (!sawNonZero || total < 1 || total > 9999) return null;
  return total;
}

const BRACKET_PAIRS: ReadonlyArray<[string, string]> = [
  ["【", "】"],
  ["[", "]"],
  ["「", "」"],
  ["（", "）"],
  ["(", ")"],
];

const NUM_PATTERN = "[0-9０-９一二两兩三四五六七八九十百千零〇壹贰貳叁參肆伍陆陸柒捌玖拾佰仟]+";
const EPISODE_MARKER_RE = new RegExp(`^(?:第\\s*(${NUM_PATTERN})\\s*[集话話回]|(?:Episode|Ep\\.?)\\s*(${NUM_PATTERN}))`, "i");

function cleanTitleText(raw: string): string {
  let cleaned = raw.trim();
  while (
    (cleaned.startsWith("**") && cleaned.endsWith("**") && cleaned.length > 4)
    || (cleaned.startsWith("__") && cleaned.endsWith("__") && cleaned.length > 4)
  ) {
    cleaned = cleaned.slice(2, -2).trim();
  }
  if (cleaned.length > 120) {
    return sliceSafe(cleaned, 120).text.trim();
  }
  return cleaned;
}

type LineMatch = {
  episodeNo: number;
  title: string;
  heading: string;
  inlineBody: string;
};

function stripMarkdownWrapper(rawLine: string): { text: string; hasMarkdown: boolean } {
  const trimmed = rawLine.trim();
  if (!trimmed) return { text: "", hasMarkdown: false };
  let hasMarkdown = false;
  let inner = trimmed;
  const mdHeading = /^#{1,6}\s+(.+)$/.exec(inner);
  if (mdHeading) {
    hasMarkdown = true;
    inner = mdHeading[1]!.trim();
  }
  while (
    (inner.startsWith("**") && inner.endsWith("**") && inner.length > 4)
    || (inner.startsWith("__") && inner.endsWith("__") && inner.length > 4)
  ) {
    hasMarkdown = true;
    inner = inner.slice(2, -2).trim();
  }
  return { text: inner, hasMarkdown };
}

function matchEpisodeHeadingLine(rawLine: string): LineMatch | null {
  const heading = rawLine.trim();
  if (!heading) return null;
  const { text: stripped, hasMarkdown } = stripMarkdownWrapper(heading);
  if (!stripped) return null;

  for (const [open, close] of BRACKET_PAIRS) {
    if (!stripped.startsWith(open)) continue;
    const closeIdx = stripped.indexOf(close, open.length);
    if (closeIdx <= open.length) continue;

    const inner = stripped.slice(open.length, closeIdx).trim();
    const marker = EPISODE_MARKER_RE.exec(inner);
    if (!marker) continue;

    const episodeNo = parseEpisodeNumberToken(marker[1] ?? marker[2] ?? "");
    if (!episodeNo) continue;

    const innerRest = inner.slice(marker[0].length).trim();
    let title = "";
    if (innerRest) {
      const sepMatch = /^[:：\-—–·|｜/、]\s*(.*)$/.exec(innerRest);
      title = cleanTitleText(sepMatch ? sepMatch[1]! : innerRest);
    }

    const afterBracket = stripped.slice(closeIdx + close.length).trim();
    let inlineBody = "";
    if (!title && afterBracket) {
      const outerSep = /^[:：\-—–·|｜]\s*(.+)$/.exec(afterBracket);
      if (outerSep) {
        const candidate = outerSep[1]!.trim();
        if (candidate.length <= 80 && !/。.+/.test(candidate)) {
          title = cleanTitleText(candidate);
        } else {
          inlineBody = afterBracket;
        }
      } else {
        inlineBody = afterBracket;
      }
    } else if (afterBracket) {
      inlineBody = afterBracket;
    }

    return { episodeNo, title, heading, inlineBody };
  }

  const marker = EPISODE_MARKER_RE.exec(stripped);
  if (!marker) return null;
  const episodeNo = parseEpisodeNumberToken(marker[1] ?? marker[2] ?? "");
  if (!episodeNo) return null;

  const afterMarker = stripped.slice(marker[0].length);
  if (!afterMarker.trim()) {
    return { episodeNo, title: "", heading, inlineBody: "" };
  }

  const sepMatch = /^\s*([:：\-—–·|｜/])\s*(.*)$/.exec(afterMarker);
  if (sepMatch) {
    const rest = sepMatch[2]!.trim();
    if (!rest) return { episodeNo, title: "", heading, inlineBody: "" };
    if (hasMarkdown || (rest.length <= 60 && !/[。！？!?].+/.test(rest))) {
      return { episodeNo, title: cleanTitleText(rest), heading, inlineBody: "" };
    }
    return { episodeNo, title: "", heading, inlineBody: rest };
  }

  if (!/^\s/.test(afterMarker)) {
    return null;
  }

  const rest = afterMarker.trim();
  if (
    hasMarkdown
    || (
      rest.length <= 40
      && !/[。！？.!?，,;；]/.test(rest)
      && !/^(?:is|was|starts|begins|ends|has|will|opens|takes|follows)\b/i.test(rest)
    )
  ) {
    return { episodeNo, title: cleanTitleText(rest), heading, inlineBody: "" };
  }

  return null;
}

function buildPreview(heading: string, inlineBody: string, content: string): string {
  let rawPreview = inlineBody.trim();
  if (!rawPreview) {
    const firstNewline = content.indexOf("\n");
    const body = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    rawPreview = body
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .join(" ");
  }
  if (!rawPreview) rawPreview = heading;
  const collapsed = rawPreview.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 140) return collapsed;
  return `${sliceSafe(collapsed, 139).text}…`;
}

export function parseComicDramaMasterScript(script: string): ParsedComicMasterEpisode[] {
  if (!script.trim()) return [];

  const matches: Array<LineMatch & { lineStart: number }> = [];
  let cursor = 0;
  for (const line of script.split(/\r?\n/)) {
    const matched = matchEpisodeHeadingLine(line);
    if (matched) {
      matches.push({ ...matched, lineStart: cursor });
    }
    const nlLen = script.slice(cursor + line.length, cursor + line.length + 2) === "\r\n" ? 2 : 1;
    cursor += line.length + nlLen;
  }

  if (!matches.length) return [];

  const byEpisode = new Map<number, { episode: ParsedComicMasterEpisode; bodyLength: number }>();
  for (let i = 0; i < matches.length; i += 1) {
    const cur = matches[i]!;
    const end = i + 1 < matches.length ? matches[i + 1]!.lineStart : script.length;
    const rawSection = script.slice(cur.lineStart, end).trim();
    const { text: content, truncated } = sliceSafe(rawSection, COMIC_SCRIPT_MAX_CHARS);
    const firstNewline = rawSection.indexOf("\n");
    const bodyLength = cur.inlineBody.trim().length
      + (firstNewline >= 0 ? rawSection.slice(firstNewline + 1).trim().length : 0);

    const parsed: ParsedComicMasterEpisode = {
      episodeNo: cur.episodeNo,
      title: cur.title,
      heading: cur.heading,
      content,
      preview: buildPreview(cur.heading, cur.inlineBody, rawSection),
      truncated,
    };

    const existing = byEpisode.get(cur.episodeNo);
    if (
      !existing
      || bodyLength > existing.bodyLength
      || (bodyLength === existing.bodyLength && rawSection.length > existing.episode.content.length)
    ) {
      byEpisode.set(cur.episodeNo, { episode: parsed, bodyLength });
    }
  }

  return Array.from(byEpisode.values())
    .map(entry => entry.episode)
    .sort((a, b) => a.episodeNo - b.episodeNo);
}

export function resolveComicEpisodeMasterScript(masterScript: string, episodeNo: number): ResolvedComicEpisodeScript {
  const normalizedEpNo = Math.max(1, Math.floor(episodeNo));
  const parsed = parseComicDramaMasterScript(masterScript);
  if (parsed.length > 0) {
    const hit = parsed.find(entry => entry.episodeNo === normalizedEpNo);
    if (hit) {
      return {
        matched: "episode",
        episodeNo: normalizedEpNo,
        title: hit.title,
        content: hit.content,
        truncated: hit.truncated,
        totalParsedEpisodes: parsed.length,
      };
    }
    return {
      matched: "none",
      episodeNo: normalizedEpNo,
      title: "",
      content: "",
      truncated: false,
      totalParsedEpisodes: parsed.length,
    };
  }

  const trimmed = masterScript.trim();
  if (trimmed && normalizedEpNo === 1) {
    const { text, truncated } = sliceSafe(trimmed, COMIC_SCRIPT_MAX_CHARS);
    return {
      matched: "whole_fallback",
      episodeNo: normalizedEpNo,
      title: "",
      content: text,
      truncated,
      totalParsedEpisodes: 0,
    };
  }

  return {
    matched: "none",
    episodeNo: normalizedEpNo,
    title: "",
    content: "",
    truncated: false,
    totalParsedEpisodes: 0,
  };
}
