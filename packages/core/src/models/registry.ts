import type { ListModelsOptions, ModelConfig, ModelRegistry, ModelType } from "./types.js";

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

  list(type?: ModelType, opts?: ListModelsOptions): ModelConfig[] {
    return Array.from(this.configs.values()).filter(
      (cfg) =>
        (type === undefined || cfg.type === type) &&
        (opts?.includeDisabled || cfg.enabled)
    );
  }

  getProvider<T = unknown>(id: string): T | undefined {
    // A disabled model is operationally offline — don't hand out its provider.
    if (this.configs.get(id)?.enabled === false) return undefined;
    const factory = this.factories.get(id);
    if (!factory) return undefined;

    if (!this.instances.has(id)) {
      this.instances.set(id, factory());
    }
    return this.instances.get(id) as T;
  }
}
