import { useEffect, useState } from "react";
import type { ComicVideoTake } from "@lot-agent/core/comic-drama";
import { ApiClientError } from "../../api/client.js";
import { useI18n } from "../../i18n/index.js";
import { VideoTakeCard } from "./ComicVideoTakes.js";
import { comicGenerationApi } from "./generation-api.js";
import { NewComicEdit } from "./ComicEditList.js";

export function ComicEditorSource({ takeId, browse, open, openEdit }: {
  takeId: string; browse: () => void; open: (seriesId: string, clipId: string) => void; openEdit: (id: string) => void;
}) {
  const { t } = useI18n();
  const [take, setTake] = useState<ComicVideoTake | "missing" | "error" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [create, setCreate] = useState(false);
  const retry = () => setAttempt(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setTake(null);
    void comicGenerationApi.videoTake(takeId, controller.signal).then(item => {
      if (!controller.signal.aborted) setTake(item);
    }).catch(error => {
      if (!controller.signal.aborted) setTake(error instanceof ApiClientError && error.status === 404 ? "missing" : "error");
    });
    return () => controller.abort();
  }, [takeId, attempt]);
  return <>
    <header className="comic-heading">
      <h1>{t("剪辑片源预览")}</h1>
      <button type="button" onClick={browse}>{t("选择其他片源")}</button>
    </header>
    {take === "missing" ? <p className="comic-empty">{t("片源不可用，请重新选择")}</p> :
      take === "error" ? <button type="button" onClick={retry}>{t("重新读取")}</button> :
      !take ? <p role="status">{t("加载中…")}</p> : <section className="comic-editor-source">
        <VideoTakeCard key={take.id} take={take} refresh={retry} selected />
        <div className="comic-actions">
          <button type="button" className="primary" onClick={() => setCreate(true)}>{t("以此片源创建工程")}</button>
          {take.ordinal !== null && <button type="button" onClick={() => open(take.seriesId, take.targetId)}>{t("打开对应分镜")}</button>}
        </div>
        {create && <NewComicEdit seed={{ takeId }} open={openEdit} close={() => setCreate(false)} />}
      </section>}
  </>;
}
