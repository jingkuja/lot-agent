import { describe, it, expect } from "vitest";
import { calcCost } from "./cost.js";
import type { ModelConfig } from "../models/types.js";

const makeLLM = (overrides?: Partial<ModelConfig>): ModelConfig => ({
  id: "test-llm",
  type: "llm",
  provider: "test",
  billingUnit: "token",
  inputPrice: 0.001,
  outputPrice: 0.002,
  unitPrice: 0,
  enabled: true,
  ...overrides,
});

const makeImage = (overrides?: Partial<ModelConfig>): ModelConfig => ({
  id: "test-image",
  type: "image",
  provider: "test",
  billingUnit: "image",
  inputPrice: 0,
  outputPrice: 0,
  unitPrice: 0.04,
  enabled: true,
  ...overrides,
});

const makeVideo = (overrides?: Partial<ModelConfig>): ModelConfig => ({
  id: "test-video",
  type: "video",
  provider: "test",
  billingUnit: "second",
  inputPrice: 0,
  outputPrice: 0,
  unitPrice: 0.5,
  enabled: true,
  ...overrides,
});

describe("calcCost", () => {
  it("calculates LLM cost correctly (元/千tokens)", () => {
    const model = makeLLM({ inputPrice: 0.001, outputPrice: 0.002 });
    const cost = calcCost(model, { inputCount: 1000, outputCount: 500 });
    // (1000*0.001 + 500*0.002) / 1000 = (1 + 1) / 1000 = 0.002
    expect(cost).toBeCloseTo(0.002, 6);
  });

  it("calculates image cost correctly (元/image)", () => {
    const model = makeImage({ unitPrice: 0.04 });
    const cost = calcCost(model, { inputCount: 0, outputCount: 3 });
    // 3 * 0.04 = 0.12
    expect(cost).toBeCloseTo(0.12, 6);
  });

  it("calculates video cost correctly (元/second)", () => {
    const model = makeVideo({ unitPrice: 0.5 });
    const cost = calcCost(model, { inputCount: 0, outputCount: 10 });
    // 10 * 0.5 = 5
    expect(cost).toBeCloseTo(5, 6);
  });

  it("returns 0 cost when inputCount and outputCount are 0 for LLM", () => {
    const model = makeLLM();
    const cost = calcCost(model, { inputCount: 0, outputCount: 0 });
    expect(cost).toBe(0);
  });

  it("calculates embedding type same as LLM (per thousand units)", () => {
    const model: ModelConfig = {
      id: "test-embed",
      type: "embedding",
      provider: "test",
      billingUnit: "token",
      inputPrice: 0.005,
      outputPrice: 0,
      unitPrice: 0,
      enabled: true,
    };
    const cost = calcCost(model, { inputCount: 2000, outputCount: 0 });
    // (2000*0.005 + 0*0) / 1000 = 10/1000 = 0.01
    expect(cost).toBeCloseTo(0.01, 6);
  });
});
