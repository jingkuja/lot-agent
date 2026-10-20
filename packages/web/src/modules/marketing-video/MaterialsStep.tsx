import type { ReactNode } from "react";
import { MARKETING_SHOT_MAX_SECONDS, marketingReferenceError, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { imageCount } from "./materials.js";
import { DraftText, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";

const IMAGE_TYPES = "image/jpeg,image/png,image/webp";

/** Step 2: presenter, scene and reference video for the video model. */
export function MaterialsStep({ form, profile, handlers, referenceVideoStatus, audioNotice, onPickPortrait }: {
  form: DraftForm; profile: MarketingVideoProfile; handlers: MaterialHandlers;
  /** What a selected reference video changes about generation. */
  referenceVideoStatus: string;
  /** Shown when the reference video changed what the board was planned for. */
  audioNotice: ReactNode;
  onPickPortrait(): void;
}) {
  const { t } = useI18n();
  const { draft, busy, frozen, ready } = form;
  const referenceError = marketingReferenceError(draft, profile);
  return <>
    <p className="mv-hint">{t("肖像用于确定出镜人物，第一张为主要参考，其余请使用同一人的照片；留空时由模型安排人物。")}</p>
    <section className="mv-material-group" aria-label={t("人物")}>
      <div className="mv-material-heading"><strong>{t("人物")}</strong><span>{t("合计最多 3 张（已选 {0} 张）", [imageCount("portrait", draft)])}</span></div>
      <div className="mv-columns">
        <div className="mv-upload"><button className="mv-upload-button" disabled={busy || frozen || !ready || imageCount("portrait", draft) >= 3} onClick={onPickPortrait}>{t("选择数字分身素材")}</button></div>
        <MaterialField form={form} slot="portrait" label="上传肖像图片（选填）" accept={IMAGE_TYPES} handlers={handlers} />
      </div>
    </section>
    <section className="mv-material-group" aria-label={t("场景")}>
      <div className="mv-material-heading"><strong>{t("场景")}</strong><span>{t("合计最多 3 张（已选 {0} 张）", [imageCount("scene", draft)])}</span></div>
      <div className="mv-columns">
        <MaterialField form={form} slot="background" label="上传背景图片（选填）" accept={IMAGE_TYPES} handlers={handlers} />
        <MaterialField form={form} slot="scene" label="上传场景图片（选填）" accept={IMAGE_TYPES} handlers={handlers} />
      </div>
      <p className="mv-hint">{t("背景图参考环境与空间布局，场景图参考构图与物品细节。图片中的其他人物不会作为主角；每镜按分镜选用相关内容。")}</p>
    </section>
    <section className="mv-material-group" aria-label={t("参考视频")}>
      <div className="mv-material-heading"><strong>{t("参考视频")}</strong><span>{t("最多 1 个")}</span></div>
      <MaterialField form={form} slot="video" label="上传参考视频（选填）" accept="video/mp4,video/quicktime" handlers={handlers} />
      {draft.assets.video ? <p className="mv-hint" role="status">{referenceVideoStatus}</p> : <p className="mv-hint">{[
        t("用于参考动作和构图，不沿用原视频台词或音乐。"),
        t("参考视频支持 MP4、MOV，最大 150 MB。"),
        profile.referenceVideo ? t("时长 {0}–{1} 秒。", [profile.referenceVideo.minSeconds, profile.referenceVideo.maxSeconds]) : "",
        profile.imagesWithReferenceVideo ? t("选择参考视频后，人物与场景图片合计最多 {0} 张。", [profile.imagesWithReferenceVideo]) : t("选择参考视频后，人物与场景图片不参与生成。"),
        profile.referenceVideoShotMaxSeconds < MARKETING_SHOT_MAX_SECONDS ? t("选择参考视频后，每镜最长 {0} 秒。", [profile.referenceVideoShotMaxSeconds]) : "",
      ].filter(Boolean).join(" ")}</p>}
      {referenceError && <p className="mv-error" role="alert">{t(referenceError)}</p>}
      {audioNotice}
    </section>
    <DraftText form={form} name="background" label="背景/场景补充描述" max={600} />
  </>;
}
