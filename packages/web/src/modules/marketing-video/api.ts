import { MarketingDraftSchema, type MarketingProject } from "@lot-agent/core/marketing-video";
import { request } from "../../api/client.js";
import type { Material } from "./materials.js";

/** A project as the editor reads it; opening a draft also returns its material previews. */
export type Project = MarketingProject & { assets?: Record<string, Material> };
// Persisted drafts and older API responses can predate newly added fields.
// Normalize before storing state or computing the saved/dirty snapshot.
export const normalizeProject = (project: Project): Project => ({ ...project, draft: MarketingDraftSchema.parse(project.draft) });
export async function requestProject(path: string, init?: RequestInit): Promise<Project> {
  return normalizeProject(await request<Project>(path, init));
}
export const json = (method: string, value: unknown) => ({ method, body: JSON.stringify(value) });
