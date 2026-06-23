import type { ModelConfig, ModelRegistry, ModelType } from "./types.js";

export class InMemoryModelRegistry implements ModelRegistry {
  private configs = new Map<string, ModelConfig>();
  private factories = new Map<string, () => unknown>();
  private instances = new Map<string, unknown>();

  register(cfg: ModelConfig, factory: () => unknown): void {
    this.configs.set(cfg.id, cfg);
    this.factories.set(cfg.id, factory);
    // Clear any cached instance when re-registering
    this.instances.delete(cfg.id);
  }

  getConfig(id: string): ModelConfig | undefined {
    return this.configs.get(id);
  }

  list(type?: ModelType): ModelConfig[] {
    const all = Array.from(this.configs.values());
    if (type === undefined) return all;
    return all.filter((cfg) => cfg.type === type);
  }

  getProvider<T = unknown>(id: string): T | undefined {
    const factory = this.factories.get(id);
    if (!factory) return undefined;

    if (!this.instances.has(id)) {
      this.instances.set(id, factory());
    }
    return this.instances.get(id) as T;
  }
}
