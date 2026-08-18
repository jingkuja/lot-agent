import { describe, expect, it } from "vitest";
import { InputError } from "./errors.js";
import { parseCaptureInput, parseCreateProfile, parseProfileList, parseUpdateProfile } from "./validators.js";

describe("customer profile validators", () => {
  it("requires a valid capture event type", () => {
    expect(() => parseCaptureInput({ customerMention: "李姐" })).toThrow(InputError);
    expect(() => parseCaptureInput({ customerMention: "李姐", eventType: "invented" })).toThrow(InputError);
  });

  it("does not silently accept an empty display-name update", () => {
    expect(() => parseUpdateProfile({ version: 1, displayName: "  " })).toThrow("displayName不能为空");
  });

  it("keeps customer region as a single free-text profile field", () => {
    expect(parseCreateProfile({
      displayName: "李姐",
      customerRegion: "华东 / 深圳南山区及周边",
      tags: ["重点客户", "重点客户"],
    })).toMatchObject({
      displayName: "李姐",
      customerRegion: "华东 / 深圳南山区及周边",
      tags: ["重点客户"],
    });
    expect(parseProfileList({ page: "2", limit: "30", relationshipStage: "prospect" })).toMatchObject({
      page: 2, limit: 30, relationshipStage: "prospect",
    });
  });
});
