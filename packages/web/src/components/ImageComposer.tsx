import { useEffect, useRef } from "react";
import { useI18n } from "../i18n/index.js";
import { IMAGE_SCENES, type ImageScene } from "../lib/image-settings.js";

const SCENE_DETAILS: Record<ImageScene, { caption: string; icon: string; ideas: { label: string; prompt: string }[] }> = {
  free: {
    caption: "海报 · 插画 · 灵感",
    icon: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
    ideas: [
      { label: "电影感海报", prompt: "一张咖啡品牌海报，暖色电影光影，咖啡杯置于窗边，蒸汽升起，留出标题空间，细腻胶片质感" },
      { label: "高级产品摄影", prompt: "一瓶香水的商业摄影，置于浅色石台上，水面折射与柔和光影，极简构图，突出玻璃质感" },
      { label: "3D 创意插画", prompt: "一座漂浮在云端的微缩花园，3D 等距视角，柔和的薄荷绿与奶油色，精致细节，干净背景" },
    ],
  },
  product_set: {
    caption: "完整产品视觉",
    icon: "M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z",
    ideas: [{ label: "通勤保温杯", prompt: "为一款奶油白保温杯制作产品套图，316 不锈钢，12 小时保温，突出通勤便携，统一简约自然风格" }],
  },
  main_images: {
    caption: "主图 + 卖点细节",
    icon: "M3 4h11v16H3ZM17 4h4v7h-4ZM17 14h4v6h-4Z",
    ideas: [{ label: "极简数码产品", prompt: "白色无线耳机的电商主副图，主图突出产品轮廓，副图展示充电盒与佩戴细节，简约科技风" }],
  },
  white_background: {
    caption: "干净利落的商品图",
    icon: "M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8Z",
    ideas: [{ label: "标准商品棚拍", prompt: "一双红色运动鞋，纯白背景，侧面 45 度，产品完整居中，柔和棚拍光，保留自然接触阴影" }],
  },
  product_scene: {
    caption: "产品不变，氛围焕新",
    icon: "M3 3h18v18H3ZM3 16l5-5 5 5 3-3 5 5M15 7h.01",
    ideas: [{ label: "自然生活场景", prompt: "将参考图中的产品放在清晨的木质餐桌上，旁边有咖啡与绿植，侧面自然光，保持产品外观和细节" }],
  },
  poster_remix: {
    caption: "参考爆款，生成品牌海报",
    icon: "M8 4h12v12M4 8h12v12H4ZM4 17l4-4 3 3 2-2 3 3",
    ideas: [
      { label: "品牌上新", prompt: "品牌：山岚茶饮。产品：冷萃茉莉茶。卖点：清爽花香，茶味回甘。海报文案：新品上市。" },
      { label: "商品卖点", prompt: "品牌：晨光家居。产品：便携保温杯。卖点：轻巧好握，适合日常通勤。保留参考图的构图。" },
    ],
  },
};

function SceneIcon({ scene }: { scene: ImageScene }) {
  return <span className="scene-dock-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d={SCENE_DETAILS[scene].icon} />
    </svg>
  </span>;
}

function FoldChevron({ up }: { up: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={up ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} />
  </svg>;
}

/** Mode rail of the image workbench. `onFold` adds the fold button, shown where the workbench sits under results. */
export function ImageComposerHeader({ scene, onChange, disabled, onFold }: {
  scene: ImageScene;
  onChange: (scene: ImageScene) => void;
  disabled: boolean;
  onFold?: () => void;
}) {
  const { t } = useI18n();
  const dock = useRef<HTMLDivElement>(null);
  // On narrow screens the rail scrolls sideways; keep the chosen type in view.
  useEffect(() => {
    dock.current?.querySelector(".scene-dock-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scene]);
  return <div className="image-studio-header">
    <div className="scene-dock" role="group" aria-label={t("创作类型")} ref={dock}>
      {IMAGE_SCENES.map((item) => <button
        key={item.value}
        type="button"
        aria-pressed={scene === item.value}
        aria-label={t(item.label)}
        className={`scene-dock-tab${scene === item.value ? " active" : ""}`}
        onClick={() => onChange(item.value)}
        disabled={disabled}
      >
        <SceneIcon scene={item.value} />
        <strong>{t(item.label)}</strong>
        <small>{t(SCENE_DETAILS[item.value].caption)}</small>
      </button>)}
    </div>
    {onFold && <button type="button" className="image-studio-fold" onClick={onFold} aria-expanded="true" aria-label={t("收起工作台")} title={t("收起工作台")}>
      <FoldChevron up={false} />
    </button>}
  </div>;
}

/** The folded workbench's handle: shows the current image type and opens the workbench. */
export function ImageComposerSlate({ scene, realText, onUnfold }: { scene: ImageScene; realText?: boolean; onUnfold: () => void }) {
  const { t } = useI18n();
  const label = IMAGE_SCENES.find((item) => item.value === scene)?.label;
  return <button type="button" className="image-studio-slate" onClick={onUnfold} aria-expanded="false" title={t("展开工作台")}
    aria-label={[t(label), realText && t("真实字体已开启"), t("展开工作台")].filter(Boolean).join(" · ")}>
    <SceneIcon scene={scene} />
    <strong>{t(label)}</strong>
    {realText && <span className="image-studio-slate-status">{t("真实字体已开启")}</span>}
    <FoldChevron up />
  </button>;
}

export function ImagePromptIdeas({ scene, onPick }: { scene: ImageScene; onPick: (prompt: string) => void }) {
  const { t } = useI18n();
  const { ideas } = SCENE_DETAILS[scene];
  if (!ideas.length) return null;
  return <div className="image-prompt-ideas">
    <span>{t("试试灵感")}</span>
    {ideas.map((idea) => <button type="button" key={idea.label} onClick={() => onPick(t(idea.prompt))}>
      {t(idea.label)}
    </button>)}
  </div>;
}
