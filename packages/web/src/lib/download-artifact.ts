/** Tools whose result carries a downloadable file link. */
const DOWNLOAD_TOOLS = new Set(["generate_ppt", "generate_document"]);

export interface DownloadArtifact {
  /** Trustworthy download URL (may be host-relative when PUBLIC_BASE_URL is unset). */
  url: string;
  /** Basename shown on the button / used as the `download` attribute. */
  filename: string;
}

/**
 * Extract the download link a document/PPT tool wrote into its OWN result.
 *
 * We deliberately read the tool's server-authored output — never the model's
 * prose reply. The model paraphrases the URL when relaying it and occasionally
 * mangles the host or drops the `/static` path segment (it has even invented a
 * whole domain when the link is host-relative), producing a broken link. The
 * tool output is deterministic, so it's the only trustworthy source.
 *
 * Returns null for non-download tools, errored results, or output with no link.
 */
export function parseDownloadArtifact(
  toolName: string | undefined,
  output: string | undefined,
  isError?: boolean
): DownloadArtifact | null {
  if (isError) return null;
  if (!toolName || !DOWNLOAD_TOOLS.has(toolName) || !output) return null;
  const match = output.match(/下载链接：\s*(\S+)/);
  if (!match) return null;
  const url = match[1];
  const path = url.split(/[?#]/)[0];
  const base = path.slice(path.lastIndexOf("/") + 1);
  let filename = base;
  try {
    filename = decodeURIComponent(base);
  } catch {
    // keep the raw basename if it isn't valid percent-encoding
  }
  return { url, filename: filename || "download" };
}
