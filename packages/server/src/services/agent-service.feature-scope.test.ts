import { describe, expect, it } from "vitest";
import { digitalEmployeeDefinition } from "@lot-agent/core";
import { digitalEmployeeAllowedToolNames } from "./agent-service.js";

describe("digitalEmployeeAllowedToolNames", () => {
  const tools = digitalEmployeeDefinition.toolNames;

  it("returns no tools when the workspace scope is missing or unknown", () => {
    expect(digitalEmployeeAllowedToolNames(undefined, tools)).toEqual([]);
    expect(digitalEmployeeAllowedToolNames("all", tools)).toEqual([]);
    expect(digitalEmployeeAllowedToolNames("customer-profile ", tools)).toEqual([]);
  });

  it("does not fall back to the full digital-employee tool list", () => {
    expect(digitalEmployeeAllowedToolNames(undefined, tools)).not.toEqual(tools);
    expect(digitalEmployeeAllowedToolNames("all", tools)).not.toContain("search_customer_profiles");
    expect(digitalEmployeeAllowedToolNames("all", tools)).not.toContain("generate_campaign_copy");
  });

  it("keeps opportunity and acquisition tools in their own scopes", () => {
    const profiles = digitalEmployeeAllowedToolNames("customer-profile", tools);
    const advisor = digitalEmployeeAllowedToolNames("opportunity-advisor", tools);
    const acquisition = digitalEmployeeAllowedToolNames("customer-acquisition", tools);
    expect(profiles).toContain("search_marketing_materials");
    expect(profiles).toContain("prepare_customer_capture");
    expect(advisor).toContain("search_customer_work_queue");
    expect(advisor).toContain("generate_individual_outreach");
    expect(advisor).not.toContain("generate_campaign_copy");
    expect(advisor).not.toContain("create_marketing_product");
    expect(acquisition).toContain("prepare_marketing_campaign");
    expect(acquisition).not.toContain("search_customer_work_queue");
    expect(acquisition).not.toContain("prepare_customer_profile_change");
  });
});
