import "../src/load-env.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Agent, SkillLoader, ToolRegistry, buildSkillPromptParts, createLoadSkillTool, digitalEmployeeDefinition,
  type Message, type Tool,
} from "@lot-agent/core";
import { MARKETING_COPY_REASONING_EFFORT } from "@lot-agent/core/marketing-video";
import { DIGITAL_EMPLOYEE_AGENT_ID, digitalEmployeeAllowedToolNames, digitalEmployeeTurnParts } from "../src/digital-employee/agent.js";
import { DIGITAL_EMPLOYEE_UNIFIED_SCOPE } from "../src/digital-employee/feature-scope.js";
import { createCustomerAcquisitionTools } from "../src/digital-employee/tools/customer-acquisition-tools.js";
import { createCustomerCaptureTools } from "../src/digital-employee/tools/customer-capture-tools.js";
import { createCustomerProfileTools } from "../src/digital-employee/tools/customer-profile-tools.js";
import { createMarketingMaterialTools } from "../src/digital-employee/tools/marketing-material-tools.js";
import { createOpportunityAdvisorTools } from "../src/digital-employee/tools/opportunity-advisor-tools.js";
import { loadLlmConfig } from "../src/config.js";
import { ProviderFactory } from "../src/models/provider-factory.js";
import { RESPONSE_LANGUAGE_POLICY } from "../src/services/response-language-policy.js";

/** Real model, no database: only the definitions reach the model and nothing executes.
 * Fails below 90% so it can guard prompt or tool description changes. */
const PASS_RATE = 0.9;
const NO_TOOL = "NO_TOOL";

interface EvalCase { id: string; object: string; input: string; expected: string[]; history?: Message[] }

function option(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

if (!process.argv.includes("--live")) throw new Error("Requires --live (real metered calls)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const apiKey = process.env.DIGITAL_EMPLOYEE_EVAL_API_KEY || process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set DIGITAL_EMPLOYEE_EVAL_API_KEY to a test account's gateway key");

const modelId = option("model", "deepseek-v4.1-flash");
const concurrency = Number(option("concurrency", "4"));
const raw = JSON.parse(await readFile(resolve(root, "config/default.json"), "utf8"));
const llmConfig = await loadLlmConfig(root);
const llm = new ProviderFactory({
  catalog: raw.modelCatalog,
  llmBaseUrl: llmConfig.openai.baseUrl!,
  llmProtocol: llmConfig.openai.protocol,
  imageBase: {} as never,
  videoBase: {} as never,
}).llm(modelId, apiKey);

const dataset = JSON.parse(await readFile(resolve(root, "tests/eval/digital-employee-tools-v1.json"), "utf8")) as {
  version: string;
  cases: EvalCase[];
};

// Tools expose their definitions without touching these services until execute.
const stub = {} as never;
const skills = new SkillLoader();
await skills.loadFromDirectory(resolve(root, "skills"));
const registry = new ToolRegistry();
const tools: Tool[] = [
  ...createCustomerCaptureTools(stub), ...createCustomerProfileTools(stub), ...createMarketingMaterialTools(stub),
  ...createCustomerAcquisitionTools(stub), ...createOpportunityAdvisorTools(stub), createLoadSkillTool(skills),
  { name: "ask_user", description: "Ask the user a question and end the turn.", parameters: {
    type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question"],
  }, async execute() { return { content: "" }; } },
];
for (const tool of tools) registry.register(tool);
const definitionChars = JSON.stringify(registry.toLLMTools(digitalEmployeeDefinition.toolNames)).length;

async function firstTool(item: EvalCase): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  const agent = new Agent({
    systemPrompt: `${digitalEmployeeDefinition.systemPrompt}\n\n${RESPONSE_LANGUAGE_POLICY}`,
    allowedToolNames: digitalEmployeeAllowedToolNames(DIGITAL_EMPLOYEE_UNIFIED_SCOPE, digitalEmployeeDefinition.toolNames),
    dynamicPromptParts: [
      ...buildSkillPromptParts(skills, item.input, DIGITAL_EMPLOYEE_AGENT_ID, digitalEmployeeDefinition.toolNames),
      ...digitalEmployeeTurnParts(DIGITAL_EMPLOYEE_UNIFIED_SCOPE),
    ],
    // Same fixed depth as the chat path, which this must match to measure the real turn.
    modelParams: MARKETING_COPY_REASONING_EFFORT[modelId]
      ? { reasoningEffort: MARKETING_COPY_REASONING_EFFORT[modelId], ...digitalEmployeeDefinition.modelParams }
      : digitalEmployeeDefinition.modelParams,
    maxIterations: 1,
  });
  try {
    const run = agent.run(item.input, {
      llm,
      toolRegistry: registry,
      toolContext: { workingDirectory: root, userId: "evaluation", featureScope: DIGITAL_EMPLOYEE_UNIFIED_SCOPE },
    }, item.history ?? [], { signal: controller.signal });
    for await (const event of run) {
      if (event.type === "tool_call") return event.name;
      if (event.type === "error") throw new Error(event.message);
    }
    return NO_TOOL;
  } finally {
    clearTimeout(timeout);
  }
}

const results: Array<{ id: string; object: string; actual: string; expected: string[]; pass: boolean; error?: string }> = [];
const queue = [...dataset.cases];
await Promise.all(Array.from({ length: concurrency }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) {
    try {
      const actual = await firstTool(item);
      const pass = item.expected.includes(actual);
      results.push({ id: item.id, object: item.object, actual, expected: item.expected, pass });
      console.log(`${pass ? "PASS" : "FAIL"} ${item.id}: ${actual}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ id: item.id, object: item.object, actual: "ERROR", expected: item.expected, pass: false, error: message });
      console.log(`ERROR ${item.id}: ${message}`);
    }
  }
}));

const passed = results.filter((item) => item.pass).length;
const rate = passed / results.length;
const summary = {
  version: dataset.version,
  modelId,
  ranAt: new Date().toISOString(),
  toolDefinitionChars: definitionChars,
  passed,
  total: results.length,
  rate,
  threshold: PASS_RATE,
  results: results.sort((a, b) => a.id.localeCompare(b.id)),
};
const output = resolve(root, "tests/eval/results");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, `digital-employee-tools-v1${modelId === "deepseek-v4.1-flash" ? "" : `-${modelId}`}.json`), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`${passed}/${results.length} = ${(rate * 100).toFixed(1)}% (threshold ${PASS_RATE * 100}%), tool definitions ${definitionChars} chars`);
if (rate < PASS_RATE) process.exitCode = 1;
