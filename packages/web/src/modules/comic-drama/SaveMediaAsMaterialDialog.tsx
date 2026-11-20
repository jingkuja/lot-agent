import { useState } from "react";
import type { ComicMaterialKind } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicLibraryApi } from "./library-api.js";
import { ChoiceSelect, comicListWords, LibraryDialog } from "./LibraryParts.js";

const imageKinds: readonly ComicMaterialKind[] = ["scene", "prop", "other"];
const kindLabels: Record<string, string> = { scene: "场景", prop: "道具", other: "其他" };

export function SaveMediaAsMaterialDialog({
  mediaId, defaultName = "", close, saved,
}: {
  mediaId: string;
  defaultName?: string;
  close: () => void;
  saved?: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = useState<ComicMaterialKind>("scene");
  return (
    <LibraryDialog
      title={t("另存为素材")}
      submitLabel={t("保存")}
      close={close}
      save={async form => {
        await comicLibraryApi.saveMediaAsMaterial(mediaId, {
          kind,
          name: String(form.get("name") ?? "").trim(),
          categoryKey: String(form.get("category") ?? "") || null,
          tags: comicListWords(String(form.get("tags") ?? "")),
        });
        saved?.();
      }}
    >
      <label>{t("素材名称")}<input name="name" required autoFocus maxLength={120} defaultValue={defaultName} /></label>
      <div className="comic-fields">
        <label>{t("素材分类")}<select value={kind} onChange={event => setKind(event.target.value as ComicMaterialKind)}>
          {imageKinds.map(value => <option key={value} value={value}>{t(kindLabels[value])}</option>)}
        </select></label>
        <label>{t("分类")}<ChoiceSelect key={kind} domain={kind} name="category" aria-label={t("分类")} empty={t("未分类")} /></label>
      </div>
      <label>{t("标签")}<input name="tags" maxLength={2400} placeholder={t("用逗号分隔")} /></label>
    </LibraryDialog>
  );
}
