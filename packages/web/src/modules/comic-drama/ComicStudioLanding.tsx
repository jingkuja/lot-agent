import { useI18n } from "../../i18n/index.js";
import {
  ArrowRightIcon,
  CharactersIcon,
  EpisodesIcon,
  MaterialsIcon,
  NewEpisodeIcon,
  ScriptIcon,
  SparklesIcon,
  StoryboardIcon,
  StudioDeskArtwork,
  TimelineEditIcon,
} from "./ComicStudioIcons.js";

type Props = {
  onCreateSeries: () => void;
  onOpenHistory: () => void;
  onOpenCharacters: () => void;
  onOpenMaterials: () => void;
  onOpenEditor: () => void;
};

const PIPELINE = [
  {
    no: "01",
    tone: "jade",
    title: "整部戏筹备",
    desc: "创建新剧，先定好全剧大纲、主要角色与总剧本",
    Icon: ScriptIcon,
  },
  {
    no: "02",
    tone: "violet",
    title: "创建分集",
    desc: "从第 1 集开始拆分剧集，自动带入全剧角色与画风",
    Icon: EpisodesIcon,
  },
  {
    no: "03",
    tone: "azure",
    title: "多分镜编排",
    desc: "每集下自由创建多分镜，设定景别、运镜与对白",
    Icon: StoryboardIcon,
  },
  {
    no: "04",
    tone: "gold",
    title: "画面生成",
    desc: "生成一致性首帧图并驱动动态镜头成片",
    Icon: SparklesIcon,
  },
  {
    no: "05",
    tone: "coral",
    title: "多轨剪辑",
    desc: "五轨时间线精剪、配乐字幕一键导出",
    Icon: TimelineEditIcon,
  },
] as const;

export function ComicStudioLanding({
  onCreateSeries,
  onOpenHistory,
  onOpenCharacters,
  onOpenMaterials,
  onOpenEditor,
}: Props) {
  const { t } = useI18n();
  return (
    <div className="comic-landing">
      <section className="comic-empty comic-hero">
        <div className="comic-hero-copy">
          <div className="comic-studio-kicker">
            <span className="comic-kicker-dot" aria-hidden="true" />
            <span>{t("创作工坊工作台")}</span>
          </div>
          <h1>{t("漫剧工厂")}</h1>
          <p className="comic-hero-lead">{t("先立项定大纲、角色与剧本，再建分集与多分镜")}</p>
          <p className="comic-hero-sub">
            {t("沿用传统剧集创作流程：先完成整部戏的大纲、角色与总剧本筹备，再从第 1 集开始拆分分集、编排多分镜、生成画面与五轨精剪。")}
          </p>
          <div className="comic-hero-actions">
            <button type="button" className="primary comic-hero-cta" onClick={onCreateSeries}>
              <NewEpisodeIcon size={17} />
              <span>{t("新建新剧")}</span>
            </button>
            <button type="button" className="comic-hero-ghost" onClick={onOpenHistory}>
              <span>{t("浏览历史剧集")}</span>
              <ArrowRightIcon size={14} />
            </button>
          </div>
          <div className="comic-hero-pills" aria-hidden="true">
            <span>{t("大纲 · 角色 · 剧本筹备")}</span>
            <span>{t("分集自动继承角色")}</span>
            <span>{t("多分镜生成与剪辑")}</span>
          </div>
        </div>
        <StudioDeskArtwork />
      </section>

      <section className="comic-pipeline-section" aria-label={t("制作流程")}>
        <header className="comic-section-bar">
          <div>
            <small>{t("创作流程")}</small>
            <h2>{t("五步漫剧制作工艺")}</h2>
          </div>
        </header>
        <ol className="comic-pipeline-grid">
          {PIPELINE.map(({ no, tone, title, desc, Icon }) => (
            <li key={no} className="comic-pipeline-card" data-tone={tone}>
              <div className="comic-pipeline-top">
                <span className="comic-pipeline-icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="comic-pipeline-no">{no}</span>
              </div>
              <strong>{t(title)}</strong>
              <p>{t(desc)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="comic-shortcuts-section" aria-label={t("工坊快捷入口")}>
        <header className="comic-section-bar">
          <div>
            <small>{t("快捷工位")}</small>
            <h2>{t("随时切入创作工位")}</h2>
          </div>
        </header>
        <div className="comic-shortcut-grid">
          <button type="button" className="comic-shortcut-card" data-tone="violet" onClick={onOpenCharacters}>
            <span className="comic-shortcut-icon" aria-hidden="true">
              <CharactersIcon size={20} />
            </span>
            <span className="comic-shortcut-body">
              <strong>{t("角色与造型资产")}</strong>
              <small>{t("沉淀主角定妆、表情与专属音色")}</small>
            </span>
            <span className="comic-shortcut-arrow" aria-hidden="true">
              <ArrowRightIcon size={16} />
            </span>
          </button>
          <button type="button" className="comic-shortcut-card" data-tone="azure" onClick={onOpenMaterials}>
            <span className="comic-shortcut-icon" aria-hidden="true">
              <MaterialsIcon size={20} />
            </span>
            <span className="comic-shortcut-body">
              <strong>{t("场景与音频素材")}</strong>
              <small>{t("整理背景、道具、配乐与氛围音效")}</small>
            </span>
            <span className="comic-shortcut-arrow" aria-hidden="true">
              <ArrowRightIcon size={16} />
            </span>
          </button>
          <button type="button" className="comic-shortcut-card" data-tone="coral" onClick={onOpenEditor}>
            <span className="comic-shortcut-icon" aria-hidden="true">
              <TimelineEditIcon size={20} />
            </span>
            <span className="comic-shortcut-body">
              <strong>{t("多轨精剪与出片")}</strong>
              <small>{t("裁切镜头、合成配音字幕并导出 MP4")}</small>
            </span>
            <span className="comic-shortcut-arrow" aria-hidden="true">
              <ArrowRightIcon size={16} />
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
