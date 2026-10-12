import { useId, useRef } from "react";
import { useI18n } from "../i18n/index.js";

const VERSIONS = [
  { name: "Mac", chip: "Apple Silicon", file: "linquclaw-arm64.dmg" },
  { name: "Mac", chip: "Intel", file: "linquclaw.dmg" },
  { name: "Windows", chip: "Windows", file: "linquclaw.exe" },
];

export function DesktopDownload() {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  return (
    <>
      <button type="button" className="desktop-download-trigger" aria-haspopup="dialog"
        onClick={() => dialog.current?.showModal()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5" />
        </svg>
        {t("桌面版下载")}
      </button>
      <dialog ref={dialog} className="desktop-download-dialog" aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.current?.close();
        }}>
        <header className="desktop-download-head">
          <div>
            <h2 id={titleId}>{t("桌面版下载")}</h2>
            <p>{t("选择适合你电脑的版本")}</p>
          </div>
          <button type="button" className="desktop-download-close" aria-label={t("关闭")} onClick={() => dialog.current?.close()}>×</button>
        </header>
        <div className="desktop-download-grid">
          {VERSIONS.map(({ name, chip, file }) => (
            <section className="desktop-download-card" key={file}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="13" rx="2" />
                <path d="M8 21h8m-4-5v5" />
              </svg>
              <h3>{name}</h3>
              <p>{chip === "Windows" ? ".exe" : chip}</p>
              <a href={`/${file}`} download={file} aria-label={`${t("下载")} ${name}${name === "Mac" ? ` ${chip}` : ""}`}>
                {t("下载")}
              </a>
            </section>
          ))}
        </div>
      </dialog>
    </>
  );
}
