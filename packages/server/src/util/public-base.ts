/**
 * Builds the URL prefix for statically-served files.
 *
 * `LocalStorage.getUrl` returns `${prefix}/${key}`. By default the prefix is a
 * host-relative path (e.g. `/static/documents`), which is fine for same-origin
 * web access but unusable when the link is handed out for external download
 * (e.g. a generated .docx on an edge "compute box" — the link has no host/IP).
 *
 * Set `PUBLIC_BASE_URL` (e.g. `http://<box-ip>:3000`) to make every static URL
 * absolute. Trailing slashes are trimmed so we never produce `//static/...`.
 */
export function staticPrefix(path: string): string {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ?? "";
  return `${base}${path}`;
}
