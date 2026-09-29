import { describe, expect, it } from "vitest";
import { loginDiagnostic } from "./miniprogram/services/login-diagnostic";

describe("login diagnostics", () => {
  it("identifies domain validation failures after importing a project", () => {
    expect(loginDiagnostic("mode", { status: 0, message: "request:fail url not in domain list" }))
      .toContain("合法域名");
  });
  it("distinguishes transport errors from server errors", () => {
    expect(loginDiagnostic("mode", { status: 0, message: "request:fail timeout" })).toContain("超时");
    expect(loginDiagnostic("server", { status: 502 })).toContain("HTTP 502");
  });
  it("never exposes raw authentication errors or payloads", () => {
    const message = loginDiagnostic("server", { status: 401, message: "secret-token", details: { code: "private-code" } });
    expect(message).toContain("HTTP 401");
    expect(message).not.toMatch(/secret-token|private-code/);
    expect(loginDiagnostic("wechat", new Error("private-code"))).toContain("AppID");
  });
});
