export function joinUrl(base: string, path: string): string {
  const root = base.replace(/\/+$/, "");
  if (!path) return root;
  if (/^https?:\/\//i.test(path)) return path;
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

export function mediaUrl(base: string, path: string | undefined | null): string {
  if (!path) return "";
  return joinUrl(base, path);
}
