export const LAYOUT_META: Record<string, { icon: string; label: string }> = {
  cover: { icon: "■", label: "封面" },
  agenda: { icon: "☰", label: "目录" },
  section: { icon: "▎", label: "章节" },
  content: { icon: "≡", label: "要点" },
  keypoints: { icon: "▦", label: "卡片" },
  stats: { icon: "▤", label: "数据" },
  compare: { icon: "▥", label: "对比" },
  timeline: { icon: "◷", label: "时间线" },
  quote: { icon: "❝", label: "引言" },
  closing: { icon: "◼", label: "结尾" },
};

export function layoutMeta(layout: string) {
  return LAYOUT_META[layout] ?? { icon: "•", label: layout };
}
