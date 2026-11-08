import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { useI18n } from "../../../i18n/index.js";
import { employeeApi } from "../api.js";
import type { MarketingProduct, ProductDocument, ProductDocumentList } from "../types.js";
import {
  DOCUMENT_ACCEPT, DOCUMENT_ERROR_TEXT, DOCUMENT_NO_RETRY, UNSUPPORTED_FILE_TEXT, supportedFile, uploadable, uploadErrorText,
} from "./product-files.js";
import { usePolling } from "../usePolling.js";

const POLL_MS = 3000;

interface Upload { key: string; file: File; error?: string; noRetry?: boolean }

function working(document: ProductDocument): boolean {
  return document.status === "pending" || document.status === "processing";
}

interface Props {
  product: MarketingProduct;
  onClose: () => void;
  onChanged: () => void;
  /** The import shows its progress on the page, behind this dialog. */
  onImporting: () => void;
}

export function ProductDocumentsDialog({ product, onClose, onChanged, onImporting }: Props) {
  const { t } = useI18n();
  const [list, setList] = useState<ProductDocumentList | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploadAbort = useRef(new AbortController());

  const load = useCallback(async () => {
    try {
      setList(await employeeApi.listProductDocuments(product.id));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "补充资料加载失败");
    }
  }, [product.id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    uploadAbort.current = controller;
    return () => controller.abort();
  }, []);

  const pending = list?.items.some(working) ?? false;
  usePolling(load, POLL_MS, pending);

  const send = async (upload: Upload) => {
    setUploads((current) => current.map((item) => item.key === upload.key ? { ...item, error: undefined } : item));
    try {
      const asset = await api.uploadFile(uploadable(upload.file), uploadAbort.current.signal);
      await employeeApi.addProductDocument(product.id, asset.assetId);
      setUploads((current) => current.filter((item) => item.key !== upload.key));
      await load();
      onChanged();
    } catch (reason) {
      if (uploadAbort.current.signal.aborted) return;
      const message = uploadErrorText(reason, "上传失败");
      const noRetry = message === UNSUPPORTED_FILE_TEXT;
      setUploads((current) => current.map((item) => item.key === upload.key ? { ...item, error: message, noRetry } : item));
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const added: Upload[] = Array.from(files).map((file, index) => ({
      key: `${Date.now()}-${index}-${file.name}`, file,
      ...(supportedFile(file) ? {} : { error: UNSUPPORTED_FILE_TEXT, noRetry: true }),
    }));
    setUploads((current) => [...current, ...added]);
    added.filter((upload) => !upload.error).forEach((upload) => void send(upload));
  };

  const act = async (document: ProductDocument, action: () => Promise<unknown>) => {
    setBusyId(document.id);
    try {
      await action();
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setBusyId(null);
    }
  };

  const remove = (document: ProductDocument) => {
    if (!window.confirm(t(`确认删除“${document.title}”？`))) return;
    void act(document, () => employeeApi.deleteProductDocument(product.id, document.id));
  };

  return <div className="de-modal-backdrop" onMouseDown={onClose}>
    <section className="de-modal product-documents-modal" role="dialog" aria-modal="true" aria-label={t("补充资料")} onMouseDown={(event) => event.stopPropagation()}>
      <div className="de-modal-head">
        <div><h2>{t("补充资料")}</h2><p>{product.name}</p></div>
        <button className="de-icon-button" aria-label={t("关闭")} onClick={onClose}>×</button>
      </div>
      <div className="product-documents-body">
        <button
          type="button"
          className={`product-documents-drop${dragging ? " is-dragging" : ""}`}
          onClick={() => input.current?.click()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
        >
          <strong>{t("把手册或说明文件拖到这里，或点击选择")}</strong>
          <span>{t("支持 PDF、Word、PPT、Excel、图片和文本文件；写话术时会自动参考")}</span>
        </button>
        <input ref={input} type="file" hidden multiple accept={DOCUMENT_ACCEPT} onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} />

        {error && <div className="de-inline-error">{t(error)}<button onClick={() => void load()}>{t("重试")}</button></div>}

        {list && <p className="product-documents-usage">
          {t(`话术可用 ${list.usage.usedChars.toLocaleString()} / ${list.usage.limitChars.toLocaleString()} 字符`)}
        </p>}

        <ul className="product-documents-list">
          {uploads.map((upload) => <li key={upload.key}>
            <div>
              <strong>{upload.file.name}</strong>
              <small className={upload.error ? "is-error" : undefined}>{upload.error ? t(upload.error) : t("上传中…")}</small>
            </div>
            {upload.error && <div className="product-documents-actions">
              {!upload.noRetry && <button className="de-row-action" onClick={() => void send(upload)}>{t("重试")}</button>}
              <button className="de-row-action" onClick={() => setUploads((current) => current.filter((item) => item.key !== upload.key))}>{t("移除")}</button>
            </div>}
          </li>)}
          {list?.items.map((document) => <DocumentRow
            key={document.id}
            document={document}
            busy={busyId === document.id}
            onRetry={() => void act(document, () => employeeApi.retryProductDocument(product.id, document.id))}
            onImport={() => void act(document, async () => {
              await employeeApi.importProductDocument(product.id, document.id);
              onImporting();
            })}
            onRemove={() => remove(document)}
          />)}
        </ul>
        {list && !list.items.length && !uploads.length && <p className="product-documents-empty">{t("还没有补充资料")}</p>}
      </div>
    </section>
  </div>;
}

interface RowProps { document: ProductDocument; busy: boolean; onRetry: () => void; onImport: () => void; onRemove: () => void }

function DocumentRow({ document, busy, onRetry, onImport, onRemove }: RowProps) {
  const { t } = useI18n();
  const failed = document.status === "failed";
  const status = failed ? t(DOCUMENT_ERROR_TEXT[document.errorCode ?? ""] ?? "这份文件没读出来，可以重试")
    : working(document) ? t("正在读取…")
      : document.usedInTalkTrack ? t("已用于话术")
        : t("内容太长，话术暂不使用，聊天中仍可查阅");
  return <li>
    <div>
      <strong>{document.title}</strong>
      <small className={failed ? "is-error" : undefined}>{status}</small>
      {document.skippedPages > 0 && <small>{t(`有 ${document.skippedPages} 页是图片，暂未读取`)}</small>}
    </div>
    <div className="product-documents-actions">
      {failed && !DOCUMENT_NO_RETRY.has(document.errorCode ?? "") && <button className="de-row-action" disabled={busy} onClick={onRetry}>{t("重试")}</button>}
      {document.status === "ready" && <button className="de-row-action" disabled={busy} onClick={onImport}>{t("整理进资料")}</button>}
      <button className="de-row-action" disabled={busy} onClick={onRemove}>{t("删除")}</button>
    </div>
  </li>;
}
