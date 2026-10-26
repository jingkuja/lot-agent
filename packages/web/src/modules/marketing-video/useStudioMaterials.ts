import { useRef, useState } from "react";
import { marketingAssetIds, type MarketingVideoProfile } from "@lot-agent/core/marketing-video";
import { api } from "../../api/client.js";
import { errorMessage } from "./api.js";
import { checkMaterial, imageLimitError, isImageSlot, type Material, type MaterialSlot } from "./materials.js";
import type { DraftSession } from "./session.js";
import type { MaterialHandlers } from "./StudioFields.js";
import type { DraftEditor } from "./useDraftEditor.js";

/** The draft's uploaded materials and their previews. A file is checked against the clip model
 * before upload; the server checks it again before any clip is paid for. */
export function useStudioMaterials({ editor, session, profile, act, setError }: {
  editor: DraftEditor; session: DraftSession; profile: MarketingVideoProfile;
  act(work: () => Promise<void>): Promise<void>; setError(message: string): void;
}) {
  const [materials, setMaterials] = useState<Record<string, Material>>({});
  const previewRefresh = useRef(new Map<string, number>());
  const { draftRef, field } = editor;

  async function selectMaterial(file: File, slot: MaterialSlot) {
    const token = session.token();
    await checkMaterial(file, slot, draftRef.current, profile);
    const value = await api.uploadFile(file, undefined, "marketing-video");
    if (!session.current(token)) return;
    const multiple = isImageSlot(slot);
    setMaterials(old => ({ ...old, [multiple ? value.assetId : slot]: { id: value.assetId, url: value.url, name: file.name, mime: value.mime } }));
    const assets = draftRef.current.assets;
    field("assets", { ...assets, [slot]: multiple ? [...marketingAssetIds(assets[slot]), value.assetId] : value.assetId });
  }
  async function refreshMaterial(id: string) {
    // A suspended tab can outlive a capability. Re-authorize the read without
    // saving a draft or retrying a paid operation. Bound broken-media retries.
    if (Date.now() - (previewRefresh.current.get(id) ?? 0) < 60_000) return;
    previewRefresh.current.set(id, Date.now());
    const token = session.token();
    try {
      const fresh = await api.getAsset(id);
      if (!session.current(token)) return;
      setMaterials(old => Object.fromEntries(Object.entries(old).map(([key, value]) => [key, value.id === id ? { ...value, url: fresh.url } : value])));
    } catch (error) { if (session.current(token)) setError(errorMessage(error)); }
  }
  const handlers: MaterialHandlers = {
    materials,
    onFiles: (slot, files) => void act(async () => {
      if (slot === "video" && files.length > 1) throw new Error("动作参考视频最多 1 个，请先移除已有视频。");
      const limitError = isImageSlot(slot) ? imageLimitError(slot, files.length, draftRef.current, profile) : "";
      if (limitError) throw new Error(limitError);
      for (const file of files) await selectMaterial(file, slot);
    }),
    onRemove: (slot, id) => {
      const next = { ...draftRef.current.assets };
      const remaining = marketingAssetIds(next[slot]).filter(value => value !== id);
      if (isImageSlot(slot) && remaining.length) next[slot] = remaining;
      else delete next[slot];
      field("assets", next);
    },
    onRefresh: id => void refreshMaterial(id),
  };
  return { materials, setMaterials, selectMaterial, handlers };
}
