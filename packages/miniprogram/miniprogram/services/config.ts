/**
 * 服务端地址，必须与服务端环境变量 `PUBLIC_BASE_URL` 保持一致。
 *
 * 小程序不再提供运行时改地址的入口：正式版受微信「合法域名」限制，用户改的地址也发不
 * 出去；本地联调直接在开发者工具里勾选「不校验合法域名」，并把这个常量临时指向本机。
 */
export const API_BASE = "https://aigc.todoucloud.com";
export const IMAGE_AGENT_ID = "image";

export const RATIOS = [
  { label: "1:1", size: "1024x1024", w: 1, h: 1 },
  { label: "3:2", size: "1536x1024", w: 3, h: 2 },
  { label: "2:3", size: "1024x1536", w: 2, h: 3 },
  { label: "16:9", size: "1920x1088", w: 16, h: 9 },
  { label: "9:16", size: "1088x1920", w: 9, h: 16 },
] as const;

export const QUALITIES = [
  { label: "自动", value: "auto" },
  { label: "高清", value: "high" },
  { label: "标准", value: "medium" },
  { label: "快速", value: "low" },
] as const;

/** 传给后台的槽位：1=快速，2=其余清晰度。具体模型由服务端 miniprogram.image 映射。 */
export const IMAGE_MODEL_FAST = "1";
export const IMAGE_MODEL_QUALITY = "2";

export function imageModelForQuality(quality: string): string {
  return quality === "low" ? IMAGE_MODEL_FAST : IMAGE_MODEL_QUALITY;
}

export const IDEAS = [
  "暖黄街灯下的深夜面馆，蒸汽和霓虹映在湿沥青上",
  "极简产品静物：陶瓷瓶与一枝洋桔梗，柔光，胶片颗粒",
  "中式园林雨天，青石与油纸伞，电影感浅景深",
  "手持一杯冰美式走在上海里弄，下午四点的斜光",
  "节日市集灯笼与糖画摊，热闹但不拥挤，暖色",
];
