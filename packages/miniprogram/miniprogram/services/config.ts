export const DEFAULT_API_BASE = "https://aigc.todoucloud.com";
export const IMAGE_AGENT_ID = "image";

export const RATIOS = [
  { label: "1:1", size: "1024x1024", w: 1, h: 1 },
  { label: "3:2", size: "1536x1024", w: 3, h: 2 },
  { label: "2:3", size: "1024x1536", w: 2, h: 3 },
  { label: "16:9", size: "1536x864", w: 16, h: 9 },
  { label: "9:16", size: "864x1536", w: 9, h: 16 },
] as const;

export const QUALITIES = [
  { label: "自动", value: "auto" },
  { label: "高清", value: "high" },
  { label: "标准", value: "medium" },
  { label: "快速", value: "low" },
] as const;

export const IDEAS = [
  "暖黄街灯下的深夜面馆，蒸汽和霓虹映在湿沥青上",
  "极简产品静物：陶瓷瓶与一枝洋桔梗，柔光，胶片颗粒",
  "中式园林雨天，青石与油纸伞，电影感浅景深",
  "手持一杯冰美式走在上海里弄，下午四点的斜光",
  "节日市集灯笼与糖画摊，热闹但不拥挤，暖色",
];
