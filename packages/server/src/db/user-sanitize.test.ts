import { describe, it, expect } from "vitest";
import { toPublicUser } from "./user-sanitize.js";

describe("toPublicUser", () => {
  it("strips api_key and email", () => {
    const pub = toPublicUser({
      id: "u1", email: "x@tokenhub.local", name: "Nik", created_at: "t",
      external_user_id: 2, username: "13881071870", api_key: "sk-secret",
    });
    expect(pub).toEqual({ id: "u1", name: "Nik", username: "13881071870" });
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("falls back name to username when name is null", () => {
    const pub = toPublicUser({
      id: "u1", email: null, name: null, created_at: "t",
      external_user_id: 2, username: "13881071870", api_key: "sk",
    });
    expect(pub.name).toBe("13881071870");
  });
});
