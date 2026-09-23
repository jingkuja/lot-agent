import { contentPolicy, type ContentPolicy } from "../static-files.js";

/** Extend the existing passive-content policy only for explicitly supported private media. */
export function knowledgeContentPolicy(mime: string): ContentPolicy {
  if (["audio/wav", "audio/mp4", "video/webm"].includes(mime)) return { contentType: mime, disposition: "inline" };
  return contentPolicy(mime);
}
