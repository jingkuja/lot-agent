import type { AgentDefinition, AgentRegistry } from "./types.js";

export class InMemoryAgentRegistry implements AgentRegistry {
  private defs = new Map<string, AgentDefinition>();

  register(def: AgentDefinition): void {
    this.defs.set(def.id, def);
  }

  get(id: string): AgentDefinition | undefined {
    return this.defs.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.defs.values()];
  }
}
