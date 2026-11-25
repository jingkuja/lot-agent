import { useEffect, useState } from "react";
import type { ComicCharacter, ComicCharacterInput, ComicDramaOption } from "@lot-agent/core/comic-drama";
import { useI18n } from "../../i18n/index.js";
import { comicDramaApi } from "./api.js";
import { ChoiceSelect, comicListWords, LibraryDialog } from "./LibraryParts.js";

export function useComicDramaOptions(refresh = 0) {
  const [options, setOptions] = useState<ComicDramaOption[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void comicDramaApi.listDramaOptions(controller.signal).then(rows => {
      if (!controller.signal.aborted) setOptions(rows);
    }).catch(() => {});
    return () => controller.abort();
  }, [refresh]);
  return options;
}

export function CharacterFormDialog({
  character,
  defaultDramaId,
  defaultDramaTitle,
  quickCast,
  close,
  save,
}: {
  character?: ComicCharacter;
  defaultDramaId?: string | null;
  defaultDramaTitle?: string | null;
  quickCast?: { label: string; defaultChecked?: boolean };
  close: () => void;
  save: (input: ComicCharacterInput, opts?: { outfitName: string; addToCast: boolean }) => Promise<void>;
}) {
  const { t } = useI18n();
  const dramas = useComicDramaOptions();
  const initialDramaId = character ? (character.dramaId ?? "") : (defaultDramaId ?? "");
  const initialDramaTitle = character ? character.dramaTitle : defaultDramaTitle;
  const [dramaId, setDramaId] = useState(initialDramaId);
  const hasSelectedInList = !dramaId || dramas.some(item => item.id === dramaId);
  return (
    <LibraryDialog
      title={t(character ? "编辑角色" : "新建角色")}
      submitLabel={t("保存")}
      close={close}
      save={form => {
        const field = (name: string) => String(form.get(name) ?? "").trim();
        const input: ComicCharacterInput = {
          name: field("name"),
          aliases: comicListWords(field("aliases")),
          tags: comicListWords(field("tags")),
          roleKey: field("role") || null,
          dramaId: dramaId || null,
          age: field("age"),
          personality: field("personality"),
          appearance: field("appearance"),
        };
        if (quickCast) {
          return save(input, {
            outfitName: field("outfitName") || t("默认造型"),
            addToCast: form.get("addToCast") === "on",
          });
        }
        return save(input);
      }}
    >
      <label>
        {t("角色名称")}
        <input name="name" autoFocus required maxLength={120} defaultValue={character?.name} />
      </label>
      <label>
        {t("归属剧目")}
        <select name="dramaId" aria-label={t("归属剧目")} value={dramaId} onChange={event => setDramaId(event.target.value)}>
          <option value="">{t("通用（不归属特定剧目）")}</option>
          {!hasSelectedInList && dramaId && (
            <option value={dramaId}>
              {dramaId === initialDramaId && initialDramaTitle ? `《${initialDramaTitle}》` : dramaId}
            </option>
          )}
          {dramas.map(item => (
            <option key={item.id} value={item.id}>
              {`《${item.title}》${item.archived ? ` (${t("已归档")})` : ""}`}
            </option>
          ))}
        </select>
        <small>{t("归属用于分类展示和快速查找，角色仍可跨剧复用。")}</small>
      </label>
      <div className="comic-fields">
        <label>
          {t("角色定位")}
          <ChoiceSelect
            domain="role"
            name="role"
            existing={character?.roleKey}
            defaultValue={character?.roleKey ?? ""}
            empty={t("未分类")}
          />
        </label>
        <label>
          {t("年龄")}
          <input name="age" maxLength={120} defaultValue={character?.age} />
        </label>
        <label>
          {t("别名")}
          <input name="aliases" maxLength={2400} defaultValue={character?.aliases.join(", ")} placeholder={t("用逗号分隔")} />
        </label>
        <label>
          {t("标签")}
          <input name="tags" maxLength={2400} defaultValue={character?.tags.join(", ")} placeholder={t("用逗号分隔")} />
        </label>
      </div>
      <label>
        {t("性格")}
        <textarea name="personality" maxLength={2000} rows={2} defaultValue={character?.personality} />
      </label>
      <label>
        {t("外貌设定")}
        <textarea name="appearance" maxLength={2000} rows={3} defaultValue={character?.appearance} />
      </label>
      {quickCast && (
        <>
          <label>
            {t("初始造型名称")}
            <input name="outfitName" maxLength={120} defaultValue={t("默认造型")} placeholder={t("例如：日常装 / 校服")} />
          </label>
          <label className="comic-sequel-option">
            <input type="checkbox" name="addToCast" defaultChecked={quickCast.defaultChecked ?? true} />
            {quickCast.label}
          </label>
        </>
      )}
    </LibraryDialog>
  );
}
