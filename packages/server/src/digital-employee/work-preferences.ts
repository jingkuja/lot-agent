import { InputError } from "./errors.js";

export const WORK_TONES = ["warm", "professional", "concise", "lively"] as const;
export type WorkTone = typeof WORK_TONES[number];

export const WORK_CHANNELS = ["wechat", "wecom", "phone", "email", "visit", "moments", "wechat_official", "channels", "douyin_kuaishou", "xiaohongshu"] as const;
export type WorkChannel = typeof WORK_CHANNELS[number];

export interface WorkPreferences {
  workTone: WorkTone | null;
  preferredChannels: WorkChannel[];
}

const TONE_TEXT: Record<WorkTone, string> = {
  warm: "warm and personal",
  professional: "professional and measured",
  concise: "short and direct",
  lively: "lively and friendly",
};

const CHANNEL_TEXT: Record<WorkChannel, string> = {
  wechat: "WeChat", wecom: "WeCom", phone: "phone calls", email: "email", visit: "in-person visits",
  moments: "WeChat Moments", wechat_official: "WeChat Official Account", channels: "WeChat Channels",
  douyin_kuaishou: "Douyin and Kuaishou", xiaohongshu: "Xiaohongshu",
};

export function parseWorkTone(value: unknown): WorkTone | null {
  if (value === null || value === undefined || value === "") return null;
  if (!WORK_TONES.includes(value as WorkTone)) throw new InputError("语气无效");
  return value as WorkTone;
}

export function parsePreferredChannels(value: unknown): WorkChannel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => !WORK_CHANNELS.includes(item as WorkChannel))) throw new InputError("常用渠道无效");
  return [...new Set(value as WorkChannel[])];
}

/** Built only from closed lists, so nothing the owner typed reaches the prompt here. */
export function workPreferenceText(preferences: Partial<WorkPreferences> | null | undefined): string | null {
  const tone = preferences?.workTone;
  const channels = preferences?.preferredChannels ?? [];
  if (!tone && channels.length === 0) return null;
  return [
    tone ? `Default tone for messages and copy: ${TONE_TEXT[tone]}.` : "",
    channels.length ? `Channels the owner usually uses, most used first: ${channels.map((channel) => CHANNEL_TEXT[channel]).join(", ")}.` : "",
    "Use these as defaults only: the current request and product rules come first, and they say nothing about any customer.",
  ].filter(Boolean).join(" ");
}
