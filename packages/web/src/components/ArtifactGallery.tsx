import { useI18n } from "../i18n/index.js";
export interface Artifact {
  assetId: string;
  url: string;
  mediaType: string;
}

interface ArtifactGalleryProps {
  artifacts: Artifact[];
}

export function ArtifactGallery({ artifacts }: ArtifactGalleryProps) {
  const { t } = useI18n();
  if (artifacts.length === 0) {
    return (
      <div className="artifact-gallery artifact-gallery--empty">
        <span>{t("暂无素材")}</span>
      </div>
    );
  }

  return (
    <div className="artifact-gallery">
      <div className="artifact-gallery-title">{t("素材")}</div>
      <div className="artifact-grid">
        {artifacts.map((a) => (
          <div key={a.assetId} className="artifact-item">
            {a.mediaType.startsWith("video/") ? (
              <video
                className="artifact-media"
                src={a.url}
                controls
                preload="metadata"
              />
            ) : (
              <img
                className="artifact-media"
                src={a.url}
                alt={a.assetId}
                loading="lazy"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
