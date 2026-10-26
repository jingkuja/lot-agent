import type { ReactNode } from "react";
import { MARKETING_SHOT_MAX_SECONDS, marketingImageCount, marketingReferenceError, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { useI18n } from "../../i18n/index.js";
import { imageCount, imageRoom, materialRule } from "./materials.js";
import { Hint, MaterialField, type DraftForm, type MaterialHandlers } from "./StudioFields.js";

/** Step 2: presenter, product, scene and motion reference video for the video model. Image
 * limits come from the active model profile. */
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
  const portrait = imageRoom("portrait", draft, profile), product = imageRoom("product", draft, profile), setting = imageRoom("scene", draft, profile);
  const { total } = profile.referenceImages;
  // Show the shared cap only when the sections can add up to more than it.
  const capped = portrait.limit + product.limit + setting.limit > total;
  const video = <section className="mv-material-group" aria-label={t("动作参考视频")}>
    <div className="mv-material-heading"><strong>{t("动作参考视频")}</strong><span>{t("最多 1 个")}</span></div>
    <MaterialField form={form} slot="video" label="上传动作参考视频（选填）" handlers={handlers} />
    {draft.assets.video ? <p className="mv-hint" role="status">{referenceVideoStatus}</p> : <Hint text="用于参考动作和构图，不沿用原视频台词或音乐。" more={[
      t(materialRule("video")),
      profile.referenceVideo && t("时长 {0}–{1} 秒。", [profile.referenceVideo.minSeconds, profile.referenceVideo.maxSeconds]),
      profile.imagesWithReferenceVideo ? t("选择动作参考视频后，参考图片合计最多 {0} 张。", [profile.imagesWithReferenceVideo]) : t("选择动作参考视频后，参考图片不参与生成。"),
      profile.referenceVideoShotMaxSeconds < MARKETING_SHOT_MAX_SECONDS && t("选择动作参考视频后，每镜最长 {0} 秒。", [profile.referenceVideoShotMaxSeconds]),
    ]} />}
    {referenceError && <p className="mv-error" role="alert">{t(referenceError)}</p>}
    {audioNotice}
  </section>;
  return <>
    <p className="mv-hint">{t("肖像用于确定出镜人物，第一张为主要参考。其余请使用同一人的照片，留空时由模型安排。")}</p>
    {capped && <p className="mv-hint">{t("所有参考图片合计最多 {0} 张（已选 {1} 张）。", [total, marketingImageCount(draft.assets)])}</p>}
    <section className="mv-material-group" aria-label={t("出镜人物")}>
      <div className="mv-material-heading"><strong>{t("出镜人物")}</strong><span>{t("最多 {0} 张（已选 {1} 张）", [portrait.limit, imageCount("portrait", draft)])}</span></div>
      <div className="mv-columns">
        <div className="mv-upload"><button className="mv-upload-button" disabled={busy || frozen || !ready || portrait.full} onClick={onPickPortrait}>{t("选择数字分身素材")}</button></div>
        <MaterialField form={form} slot="portrait" label="上传肖像图片（选填）" handlers={handlers} full={portrait.full} />
      </div>
    </section>
    <section className="mv-material-group" aria-label={t("产品")}>
      <div className="mv-material-heading"><strong>{t("产品")}</strong><span>{t("最多 {0} 张（已选 {1} 张）", [product.limit, imageCount("product", draft)])}</span></div>
      <MaterialField form={form} slot="product" label="上传产品样例图（选填）" handlers={handlers} full={product.full} />
      <Hint text="产品图用于还原产品外观、颜色、包装和标识。"
        more={[t("可上传同一产品的不同角度或细节，建议主体清晰、背景简洁。"), t("价格、功效等信息仍以文案为准。")]} />
    </section>
    <section className="mv-material-group" aria-label={t("场景")}>
      <div className="mv-material-heading"><strong>{t("场景")}</strong><span>{t("最多 {0} 张（已选 {1} 张）", [setting.limit, imageCount("scene", draft)])}</span></div>
      <div className="mv-columns">
        <MaterialField form={form} slot="background" label="上传背景图片（选填）" handlers={handlers} full={setting.full} />
        <MaterialField form={form} slot="scene" label="上传场景图片（选填）" handlers={handlers} full={setting.full} />
      </div>
      <Hint text="背景图参考环境与空间布局，场景图参考构图与物品细节。" more={[t("图片中的其他人物不会作为主角；每镜按分镜选用相关内容。")]} />
    </section>
    {/* With this model a reference video replaces every image, so it is an advanced choice. */}
    {profile.imagesWithReferenceVideo || draft.assets.video ? video
      : <details className="mv-advanced"><summary>{t("高级设置：动作参考视频")}</summary>{video}</details>}
  </>;
}
