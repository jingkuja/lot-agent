import type {
  Tool,
  LLMTool,
  ToolResult,
  ToolContext,
  ToolExecConfig,
  ToolErrorKind,
} from "../types/index.js";
import { DEFAULT_TOOL_EXEC_CONFIG } from "../types/index.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private defaultConfig: ToolExecConfig = { ...DEFAULT_TOOL_EXEC_CONFIG };

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return [...this.tools.values()];
  }

  toLLMTools(names?: string[]): LLMTool[] {
    const tools = names !== undefined
      ? this.getAll().filter((t) => names.includes(t.name))
      : this.getAll();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  setDefaultConfig(config: Partial<ToolExecConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
    opts: { signal?: AbortSignal } = {}
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Tool not found: ${name}`,
        isError: true,
        errorKind: "not_found",
      };
    }

    // Merge default config with per-tool overrides
    const config = this.mergeConfig(tool);

    // Expose the run signal to the tool itself, so signal-aware tools can abort.
    const execContext: ToolContext = opts.signal
      ? { ...context, signal: opts.signal }
      : context;

    return this.executeWithRetry(tool, input, execContext, config, opts.signal);
  }

  private mergeConfig(tool: Tool): ToolExecConfig {
    const overrides = tool.execConfig ?? {};
    return {
      timeoutMs: overrides.timeoutMs ?? this.defaultConfig.timeoutMs,
      retry: {
        maxRetries:
          overrides.retry?.maxRetries ?? this.defaultConfig.retry.maxRetries,
        baseDelayMs:
          overrides.retry?.baseDelayMs ??
          this.defaultConfig.retry.baseDelayMs,
        retryableKinds:
          overrides.retry?.retryableKinds ??
          this.defaultConfig.retry.retryableKinds,
      },
    };
  }

  private async executeWithRetry(
    tool: Tool,
    input: unknown,
    context: ToolContext,
    config: ToolExecConfig,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    let lastResult: ToolResult | null = null;

    for (let attempt = 0; attempt <= config.retry.maxRetries; attempt++) {
      if (signal?.aborted) return abortedResult(tool.name);

      // Execute with timeout
      const result = await this.executeWithTimeout(
        tool,
        input,
        context,
        config.timeoutMs,
        signal
      );

      // Success — return immediately
      if (!result.isError) return result;

      lastResult = result;

      // Don't retry once the run is aborting.
      if (signal?.aborted) return result;

      // Check if retryable
      const kind = result.errorKind ?? "unknown";
      if (!config.retry.retryableKinds.includes(kind)) break;

      // Last attempt — don't wait
      if (attempt >= config.retry.maxRetries) break;

      // Exponential backoff with jitter
      const delay =
        config.retry.baseDelayMs * Math.pow(2, attempt) +
        Math.random() * 500;
      await sleep(Math.min(delay, 10_000));
    }

    // All retries exhausted — return last error with structured info
    return lastResult!;
  }

  private async executeWithTimeout(
    tool: Tool,
    input: unknown,
    context: ToolContext,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ToolResult> {
    const races: Promise<ToolResult>[] = [
      tool.execute(input, context),
      timeout(timeoutMs),
    ];
    // Stop waiting on a tool that ignores the signal the moment the run aborts;
    // its work is discarded so the loop can wind down promptly.
    if (signal) races.push(abortRace(signal));
    try {
      return await Promise.race(races);
    } catch (error) {
      if (error instanceof AbortError) return abortedResult(tool.name);
      if (error instanceof TimeoutError) {
        return {
          content: `Tool '${tool.name}' timed out after ${timeoutMs}ms`,
          isError: true,
          errorKind: "timeout",
          retryAfterMs: timeoutMs,
        };
      }
      return this.classifyError(error, tool.name);
    }
  }

  private classifyError(error: unknown, toolName: string): ToolResult {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();

    let kind: ToolErrorKind = "unknown";
    let retryAfterMs: number | undefined;

    if (
      lower.includes("econnrefused") ||
      lower.includes("econnreset") ||
      lower.includes("etimedout") ||
      lower.includes("fetch failed") ||
      lower.includes("network") ||
      lower.includes("socket hang up")
    ) {
      kind = "network";
      retryAfterMs = 2000;
    } else if (
      lower.includes("enoent") ||
      lower.includes("not found") ||
      lower.includes("404")
    ) {
      kind = "not_found";
    } else if (
      lower.includes("eperm") ||
      lower.includes("eacces") ||
      lower.includes("403") ||
      lower.includes("permission")
    ) {
      kind = "permission";
    } else if (
      lower.includes("invalid") ||
      lower.includes("400") ||
      lower.includes("bad request")
    ) {
      kind = "validation";
    }

    return {
      content: `Tool '${toolName}' error [${kind}]: ${message}`,
      isError: true,
      errorKind: kind,
      retryAfterMs,
    };
  }
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timeout after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

class AbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "AbortError";
  }
}

function abortedResult(toolName: string): ToolResult {
  return {
    content: `Tool '${toolName}' aborted`,
    isError: true,
    errorKind: "unknown",
  };
}

function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }
    signal.addEventListener("abort", () => reject(new AbortError()), {
      once: true,
    });
  });
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new TimeoutError(ms)), ms)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
