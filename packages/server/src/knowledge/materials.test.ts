import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeMaterials } from "./materials.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(type = "image", key = "picture.png") {
  const root = await mkdtemp(join(tmpdir(), "material-delete-")); roots.push(root);
  const folder = join(root, type === "upload" ? "uploads" : "assets");
  await mkdir(folder); await writeFile(join(folder, "picture.png"), "image");
  const query = vi.fn(async (_sql: string, _values: string[]) => ({ rows: [{ id: "asset", type, storage_key: key }] }));
  const transaction = vi.fn(async (sql: string, values?: string[]) => {
    if (sql.startsWith("SELECT a.id")) return query(sql, values!);
    return { rows: [] as { id: string; type: string; storage_key: string }[] };
  });
  const release = vi.fn();
  const service = new KnowledgeMaterials({ pool: { query, connect: async () => ({ query: transaction, release }) } } as any, {} as any, root);
  return { root, folder, query, service, transaction, release };
}
describe("permanent material deletion", () => {
  it.each(["image", "upload"])("deletes the %s original and asset record", async (type) => {
    const { service, folder, transaction } = await fixture(type);
    expect(await service.remove("owner", "asset")).toEqual({ ok: true });
    await expect(readFile(join(folder, "picture.png"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(transaction).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM assets"), ["owner", "asset"]);
    expect(transaction).toHaveBeenLastCalledWith("COMMIT");
  });
  it("rejects materials outside the personal ownership scope without deleting files", async () => {
    const { service, folder, query } = await fixture();
    query.mockResolvedValue({ rows: [] });
    await expect(service.remove("other", "asset")).rejects.toMatchObject({ status: 404 });
    expect(await readFile(join(folder, "picture.png"), "utf8")).toBe("image");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("a.user_id=$1::text AND NOT EXISTS");
  });
  it("rejects symlinks outside the material storage directory", async () => {
    const { service, root, folder, query } = await fixture("image", "escape.png");
    await writeFile(join(root, "outside.png"), "keep");
    await symlink(join(root, "outside.png"), join(folder, "escape.png"));
    await expect(service.remove("owner", "asset")).rejects.toMatchObject({ status: 404 });
    expect(await readFile(join(root, "outside.png"), "utf8")).toBe("keep");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("can finish deletion when the original file is already absent", async () => {
    const { service, transaction } = await fixture("image", "missing.png");
    expect(await service.remove("owner", "asset")).toEqual({ ok: true });
    expect(transaction).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM assets"), ["owner", "asset"]);
  });
  it("preserves an image referenced by a poster, task or share", async () => {
    const { service, folder, transaction, release } = await fixture();
    transaction.mockResolvedValue({ rows: [{ id: "asset", type: "image", storage_key: "picture.png" }] });
    await expect(service.remove("owner", "asset")).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(folder, "picture.png"), "utf8")).toBe("image");
    expect(transaction).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalled();
  });
});
