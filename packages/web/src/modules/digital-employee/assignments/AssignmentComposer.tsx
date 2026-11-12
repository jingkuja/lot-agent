import { useEffect, useRef, useState } from "react";
import { api, request, type UploadedAttachment } from "../../../api/client.js";
import type { ModelCatalog } from "../../../hooks/useModels.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { Assignment } from "../types.js";
import { MODE_HINTS, MODE_LABELS } from "./copy.js";

const MAX_FILES = 10;
const MODES: Array<Assignment["mode"]> = ["autonomous", "responsive"];

/** One sentence is enough. Everything else stays folded away and has a default. */
export function AssignmentComposer({ modelCatalog, onCreated }: { modelCatalog: ModelCatalog; onCreated: () => void }) {
  const { t, modelName } = useI18n();
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState<Assignment["mode"]>("autonomous");
  const [files, setFiles] = useState<UploadedAttachment[]>([]);
  const [modelId, setModelId] = useState("");
  const [creditLimit, setCreditLimit] = useState("");
  const [subtasks, setSubtasks] = useState("");
  const [subtaskLimit, setSubtaskLimit] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ connected?: boolean }>("/feishu/status", { signal: controller.signal })
      .then((status) => setUnreachable(status.connected !== true))
      .catch(() => { if (!controller.signal.aborted) setUnreachable(true); });
    return () => controller.abort();
  }, []);

  const addFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    setUploading(true); setError(null);
    try {
      const uploaded = await Promise.all([...picked].slice(0, MAX_FILES - files.length).map((file) => api.uploadFile(file)));
      setFiles((current) => [...current, ...uploaded]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "上传失败");
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  };

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await employeeApi.createAssignment({
        goal: goal.trim(), mode, modelId: modelId || undefined,
        attachments: files.map((file) => ({ assetId: file.assetId, filename: file.filename })),
        creditLimit: creditLimit.trim() ? Number(creditLimit) : null,
        subtasks: subtasks.split("\n").map((line) => line.trim()).filter(Boolean),
        subtaskLimit: subtaskLimit.trim() ? Number(subtaskLimit) : null,
      });
      setGoal(""); setFiles([]); setCreditLimit(""); setModelId(""); setSubtasks(""); setSubtaskLimit("");
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "没有交代成功，请再试一次");
    } finally {
      setSaving(false);
    }
  };

  const empty = !goal.trim() && !files.length;
  return <section className="de-assignment-composer" aria-label={t("交代一件事")}>
    <textarea
      aria-label={t("交代一件事")}
      placeholder={t("一句话交代任务，比如：查查附近同类店铺的开业活动，给我写一份优惠方案")}
      rows={3}
      maxLength={8000}
      value={goal}
      onChange={(event) => setGoal(event.target.value)}
    />
    {files.length > 0 && <ul className="de-assignment-files">
      {files.map((file) => <li key={file.assetId}>
        <span>{file.filename}</span>
        <button
          type="button"
          aria-label={t("移除 {0}", [file.filename])}
          onClick={() => setFiles((current) => current.filter((item) => item.assetId !== file.assetId))}
        >×</button>
      </li>)}
    </ul>}
    <fieldset className="de-assignment-mode">
      <legend>{t("模式")}</legend>
      {MODES.map((value) => <label key={value}>
        <input type="radio" name="assignment-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
        <span>{t(MODE_LABELS[value])}</span>
      </label>)}
    </fieldset>
    <details>
      <summary>{t("更多设置")}</summary>
      <div className="de-assignment-options">
        <label>
          <span>{t("模型")}</span>
          <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
            <option value="">{t("默认")}</option>
            {modelCatalog.llm.map((model) => <option key={model.id} value={model.id}>{modelName(model.id)}</option>)}
          </select>
        </label>
        <label>
          <span>{t("费用上限（积分）")}</span>
          <input type="number" min="1" step="1" inputMode="numeric" placeholder={t("不设上限")} value={creditLimit} onChange={(event) => setCreditLimit(event.target.value)} />
        </label>
        <label>
          <span>{t("子任务数量上限")}</span>
          <input type="number" min="1" step="1" inputMode="numeric" placeholder={t("不设上限")} value={subtaskLimit} onChange={(event) => setSubtaskLimit(event.target.value)} />
        </label>
        <label className="is-wide">
          <span>{t("子任务（一行一个，可以不填，员工会自己拆）")}</span>
          <textarea rows={3} value={subtasks} onChange={(event) => setSubtasks(event.target.value)} />
        </label>
      </div>
    </details>
    {error && <div className="de-inline-error" role="alert"><span>{t(error)}</span></div>}
    <footer>
      <input ref={input} type="file" multiple hidden onChange={(event) => void addFiles(event.target.files)} />
      <button type="button" className="de-secondary-button" disabled={uploading || files.length >= MAX_FILES} onClick={() => input.current?.click()}>
        {t(uploading ? "上传中…" : "附文件")}
      </button>
      <small>{t(MODE_HINTS[mode])}</small>
      <button type="button" className="de-primary-button" disabled={empty || saving || uploading} onClick={() => void submit()}>{t("开始")}</button>
    </footer>
    {unreachable && <p className="de-assignment-hint">{t(mode === "responsive" ? "还没接入飞书，要回到这里才能看到问题和结果。" : "还没接入飞书，结果只能回到这里查看。")}</p>}
  </section>;
}
