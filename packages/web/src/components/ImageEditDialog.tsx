import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/index.js";
import { shouldSubmitComposer } from "../lib/composer-keyboard.js";

interface Props {
  imageUrl: string;
  /** The image's recorded size, kept for the edit; unknown on older messages. */
  size?: string;
  /** Starts an image-to-image generation with this image as the reference.
   * Returns an error to keep the dialog open, or nothing once it is sent. */
  onSubmit: (prompt: string) => string | void | Promise<string | void>;
  redo?: boolean;
  onClose: () => void;
}

/** Edit a generated image in place: the image plus a revision prompt, sent as an
 * image-to-image request without going through the chat composer. */
export function ImageEditDialog({ imageUrl, size, onSubmit, onClose, redo = false }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const ready = redo || prompt.trim().length > 0;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const submit = async () => {
    if (!ready || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const failure = await onSubmit(prompt.trim());
      if (failure) setError(failure);
      else onClose();
    } catch {
      setError(redo ? "重做失败，请稍后重试" : "修改失败，请稍后重试");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog ref={dialog} className="image-edit-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="image-edit-head">
        <h2 id={titleId}>{t(redo ? "重做这张图片" : "编辑图片")}</h2>
        <button type="button" className="image-edit-close" onClick={onClose} disabled={busy} aria-label={t("关闭")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </header>
      <div className="image-edit-preview">
        <img src={imageUrl} alt={t("当前生成图")} />
      </div>
      <form className="image-edit-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <textarea
          autoFocus
          rows={2}
          value={prompt}
          maxLength={redo ? 600 : 4000}
          disabled={busy}
          placeholder={t(redo ? "补充修改要求（选填）" : "请输入修改要求，例如：把背景换成海边")}
          aria-label={t("修改要求")}
          onChange={(event) => { setPrompt(event.target.value); setError(null); }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(event) => {
            if (!shouldSubmitComposer({
              key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode,
            }, composing)) return;
            event.preventDefault();
            void submit();
          }}
        />
        {ready && (
          <button type="submit" className={`image-edit-send${redo ? " image-edit-send--redo" : ""}`}
            disabled={busy} aria-label={t(redo ? "重做" : "发起修改")}>
            {redo ? t(busy ? "正在提交…" : "重做") : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" /><path d="m5 12 7-7 7 7" />
            </svg>}
          </button>
        )}
      </form>
      {error ? <p className="image-edit-error" role="alert">{t(error)}</p>
        : <p className="image-edit-hint">{redo ? t("沿用原图要求并应用补充说明，按 1 张图片计费。") : size
          ? t("将以这张图为参考图生成新图片，保持原图比例与设置（{0}），模型为输入框当前所选。", [size.replace("x", "×")])
          : t("将以这张图为参考图生成新图片，沿用输入框当前的模型与尺寸设置。")}</p>}
    </dialog>
  );
}
