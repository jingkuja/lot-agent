import type { ComicDramaEpisodeBrief } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";

type HierarchyBarProps = {
  dramaTitle: string;
  episodeCount: number;
  episodeId: string;
  episodeNo: number;
  episodeTitle: string;
  episodes: readonly ComicDramaEpisodeBrief[];
  activeClipOrdinal: number | null;
  activeClipScene?: string;
  totalClips: number;
  locked: boolean;
  onSelectEpisode: (episodeId: string) => void;
  onAddEpisode: () => void;
  onOpenDrama?: () => void;
  onEditDrama: () => void;
  onOpenDramaHistory: () => void;
  onFocusClip?: () => void;
};

export function ComicWorkspaceHierarchyBar({
  dramaTitle, episodeCount, episodeId, episodeNo, episodeTitle, episodes,
  activeClipOrdinal, activeClipScene, totalClips, locked,
  onSelectEpisode, onAddEpisode, onOpenDrama, onEditDrama, onOpenDramaHistory, onFocusClip,
}: HierarchyBarProps) {
  const { t } = useI18n();
  const sortedEpisodes = episodes.length
    ? [...episodes].sort((a, b) => a.episodeNo - b.episodeNo)
    : [{ id: episodeId, dramaId: "", episodeNo, title: episodeTitle } as ComicDramaEpisodeBrief];
  return (
    <nav className="comic-hierarchy-bar" aria-label={t("剧集层级路径")}>
      <div className="comic-hierarchy-tier" data-tier="drama">
        <span className="comic-hierarchy-level">{t("整部剧集")}</span>
        {onOpenDrama ? (
          <button type="button" className="comic-hierarchy-drama-link" onClick={onOpenDrama}>
            《{dramaTitle}》
          </button>
        ) : (
          <strong className="comic-hierarchy-name">《{dramaTitle}》</strong>
        )}
        <small className="comic-hierarchy-count">{t("共 {0} 集", [Math.max(episodeCount, sortedEpisodes.length)])}</small>
        <div className="comic-hierarchy-actions">
          {onOpenDrama && (
            <button type="button" className="comic-hierarchy-btn" onClick={onOpenDrama}>
              {t("全剧筹备")}
            </button>
          )}
          {!locked && (
            <button type="button" className="comic-hierarchy-btn" onClick={onEditDrama}>
              {t("编辑整部剧集")}
            </button>
          )}
          <button type="button" className="comic-hierarchy-btn" onClick={onOpenDramaHistory}>
            {t("剧集总览")}
          </button>
        </div>
      </div>
      <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
      <div className="comic-hierarchy-tier" data-tier="episode">
        <span className="comic-hierarchy-level">{t("第 {0} 集", [episodeNo])}</span>
        <select
          className="comic-hierarchy-select"
          aria-label={t("切换分集")}
          value={episodeId}
          onChange={event => {
            if (event.target.value && event.target.value !== episodeId) onSelectEpisode(event.target.value);
          }}
        >
          {sortedEpisodes.map(ep => (
            <option key={ep.id} value={ep.id}>
              {t("第 {0} 集", [ep.episodeNo])} · {ep.title}
            </option>
          ))}
        </select>
        {!locked && (
          <button type="button" className="comic-hierarchy-btn" onClick={onAddEpisode}>
            ＋ {t("新增分集")}
          </button>
        )}
      </div>
      <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
      <div className="comic-hierarchy-tier" data-tier="clip">
        {activeClipOrdinal !== null ? (
          onFocusClip ? (
            <button type="button" className="comic-hierarchy-clip-btn" onClick={onFocusClip}>
              <span className="comic-hierarchy-level">{t("分镜 {0}/{1}", [activeClipOrdinal, totalClips])}</span>
              <span className="comic-hierarchy-clip-scene">{activeClipScene || t("未命名分镜")}</span>
            </button>
          ) : (
            <>
              <span className="comic-hierarchy-level">{t("分镜 {0}/{1}", [activeClipOrdinal, totalClips])}</span>
              <span className="comic-hierarchy-clip-scene">{activeClipScene || t("未命名分镜")}</span>
            </>
          )
        ) : (
          <span className="comic-hierarchy-muted">{t("暂无分镜")}</span>
        )}
      </div>
    </nav>
  );
}

export function ComicClipOriginBadge({
  dramaTitle, episodeNo, episodeTitle, clipOrdinal, totalClips,
}: {
  dramaTitle: string;
  episodeNo: number;
  episodeTitle: string;
  clipOrdinal?: number | null;
  totalClips?: number | null;
}) {
  const { t } = useI18n();
  return (
    <div className="comic-clip-origin" aria-label={t("当前分镜所属剧集与分集")}>
      <span className="comic-origin-node">
        <small>{t("整部剧集")}</small>
        <strong>{dramaTitle}</strong>
      </span>
      <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
      <span className="comic-origin-node">
        <small>{t("第 {0} 集", [episodeNo])}</small>
        <strong>{episodeTitle}</strong>
      </span>
      {clipOrdinal != null && (
        <>
          <span className="comic-hierarchy-sep" aria-hidden="true">›</span>
          <span className="comic-origin-node" data-tier="clip">
            <small>{t("当前分镜")}</small>
            <strong>{totalClips ? t("分镜 {0}/{1}", [clipOrdinal, totalClips]) : t("分镜 {0}", [clipOrdinal])}</strong>
          </span>
        </>
      )}
    </div>
  );
}
