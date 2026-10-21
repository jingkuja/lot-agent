import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPresenterMediaRoutes, presenterFile, signPresenterFile, PRESENTER_LINK_TTL_MS } from "./files.js";

const key = Buffer.alloc(32, 7).toString("base64");
const project = "11111111-1111-4111-8111-111111111111";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "presenter-files-"));
  await mkdir(join(root, "digital-presenter", project, "jobs", "22222222-2222-4222-8222-222222222222"), { recursive: true });
  await writeFile(join(root, "digital-presenter", project, "33333333-3333-4333-8333-333333333333.wav"), "RIFF-take");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("presenter media links", () => {
  const file = "33333333-3333-4333-8333-333333333333.wav";
  const fetchToken = (url: string) => createPresenterMediaRoutes(root, key).request(`/${url.split("/").pop()}`);

  it("serves exactly the signed file to an unauthenticated vendor", async () => {
    const url = await signPresenterFile(root, project, file, { masterKey: key, publicBaseUrl: "https://pub.example/" });
    expect(url).toMatch(/^https:\/\/pub\.example\/api\/public\/digital-presenter-media\/[A-Za-z0-9_-]+\.wav$/);
    const response = await fetchToken(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/wav");
    expect(await response.text()).toBe("RIFF-take");
  });

  it("refuses expired, altered and foreign links", async () => {
    const expired = await signPresenterFile(root, project, file, { masterKey: key, publicBaseUrl: "https://pub.example", now: Date.now() - PRESENTER_LINK_TTL_MS - 1000 });
    expect((await fetchToken(expired)).status).toBe(404);
    const url = await signPresenterFile(root, project, file, { masterKey: key, publicBaseUrl: "https://pub.example" });
    await writeFile(join(root, "digital-presenter", project, file), "changed");
    expect((await fetchToken(url)).status).toBe(404);
    const other = await signPresenterFile(root, project, file, { masterKey: Buffer.alloc(32, 9).toString("base64"), publicBaseUrl: "https://pub.example" });
    expect((await fetchToken(other)).status).toBe(404);
    expect((await createPresenterMediaRoutes(root, key).request("/not-a-token")).status).toBe(404);
  });

  it("only resolves the draft's own file names", async () => {
    await expect(presenterFile(root, project, "../secret.wav")).rejects.toThrow("文件不可用");
    await expect(presenterFile(root, project, "jobs/x/../../a.wav")).rejects.toThrow("文件不可用");
    await expect(presenterFile(root, "not-a-uuid", file)).rejects.toThrow("文件不可用");
    await expect(presenterFile(root, project, "44444444-4444-4444-8444-444444444444.wav")).rejects.toThrow("文件不可用");
    expect(await presenterFile(root, project, file)).toContain(project);
  });
});
