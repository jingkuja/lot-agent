import { COMIC_VOICE_PROMPT_MAX, comicVoicePreviewFormats, comicVoicePreviewSampleRates } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { translate } from "../../i18n/locale.js";

type PreviewLanguage = "zh" | "en";

const voiceTraits = [
  { key: "gender", label: "声音性别", options: ["男声", "女声", "中性声线"] },
  { key: "age", label: "年龄感", options: ["儿童感", "少年感", "青年感", "中年感", "老年感"] },
  { key: "pitch", label: "音高", options: ["高音区", "偏高音区", "中音区", "偏低音区", "低音区"] },
  { key: "pace", label: "语速", options: ["语速慢", "语速偏慢", "语速适中", "语速偏快", "语速快"] },
  { key: "timbre", label: "音色质感", options: ["清脆", "浑厚", "沙哑", "有磁性", "圆润", "甜美", "通透", "带气声"] },
  { key: "emotion", label: "情绪基调", options: ["温柔", "开朗", "活泼", "沉稳", "严肃", "冷静", "俏皮", "神秘"] },
  { key: "articulation", label: "吐字", options: ["吐字清晰", "咬字有力", "吐字自然松弛", "吐字轻柔"] },
  { key: "intonation", label: "语调", options: ["语调平稳", "语调上扬", "语调下沉", "语调起伏明显"] },
  { key: "delivery", label: "表演风格", options: ["自然对话", "动画表演", "戏剧化表达", "轻声细语", "播音风格", "故事讲述"] },
  { key: "usage", label: "配音用途", options: ["角色对白", "旁白解说", "内心独白", "预告片配音"] },
] as const;

export function voiceDesignPrompt(form: FormData, language: PreviewLanguage) {
  const traits = voiceTraits.flatMap(({ key, options }) => {
    const value = options.find(option => option === form.get(key));
    return value ? [translate(value, language)] : [];
  });
  const notes = String(form.get("prompt") ?? "").trim();
  const separator = language === "zh" ? "，" : ", ";
  return [traits.join(separator), notes].filter(Boolean).join(language === "zh" ? "。\n" : ".\n");
}

export function ComicVoiceDesignFields({ language, setLanguage }: { language: PreviewLanguage; setLanguage: (value: PreviewLanguage) => void }) {
  const { t } = useI18n();
  return <>
    <div className="comic-fields" role="group" aria-label={t("音色特征")}>
      {voiceTraits.map(({ key, label, options }) => <label key={key}>{t(label)}<select name={key} defaultValue="">
        <option value="">{t("不指定")}</option>
        {options.map(option => <option key={option} value={option}>{t(option)}</option>)}
      </select></label>)}
    </div>
    <label>{t("补充音色描述")}<textarea name="prompt" maxLength={COMIC_VOICE_PROMPT_MAX} rows={2}
      aria-describedby="comic-voice-prompt-hint" placeholder={t("例如：平时说话克制，紧张时尾音略带颤抖。")} /></label>
    <small id="comic-voice-prompt-hint">
      {t("可选择音色特征、填写描述，或两者搭配。合并后的中英文描述最多 {0} 字符。", [COMIC_VOICE_PROMPT_MAX])}
    </small>
    <label>{t("试听语言")}<select value={language} onChange={event => setLanguage(event.target.value === "zh" ? "zh" : "en")}>
      <option value="zh">{t("中文")}</option>
      <option value="en">{t("英文")}</option>
    </select></label>
    <label>{t("试听台词")}<textarea key={language} name="text" required minLength={15} maxLength={200} rows={2}
      defaultValue={language === "zh" ? "雨停之前，我们把剩下的故事说完吧。" : "Before the rain stops, let's finish telling the rest of the story."} /></label>
    <details className="comic-subcard comic-voice-audition">
      <summary>{t("试听音频设置")}</summary>
      <div className="comic-fields">
        <label>{t("试听采样率")}<select name="sampleRate" defaultValue="24000">
          {comicVoicePreviewSampleRates.map(rate => <option key={rate} value={rate}>{rate / 1000} kHz</option>)}
        </select></label>
        <label>{t("试听格式")}<select name="previewFormat" defaultValue="wav">
          {comicVoicePreviewFormats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}
        </select></label>
      </div>
    </details>
  </>;
}
