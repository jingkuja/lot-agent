import type { Agent, Conversation } from "../api/client.js";

export const DIGITAL_EMPLOYEE_AGENT_ID = "digital_employee";
export const DIGITAL_EMPLOYEE_UNIFIED_SCOPE = "employee";

/** The digital employee is a product module, never a normal installable Agent. */
export function withoutDigitalEmployee<T extends Pick<Agent, "id">>(agents: T[]): T[] {
  return agents.filter((agent) => agent.id !== DIGITAL_EMPLOYEE_AGENT_ID);
}

/** An `employee` conversation belongs to every entry; older ones stay with their module. */
export function digitalEmployeeConversationsForScope<T extends Pick<Conversation, "metadata">>(conversations: T[], scope: string): T[] {
  return conversations.filter((conversation) => {
    const stored = conversation.metadata?.digitalEmployeeFeatureScope;
    return stored === scope || stored === DIGITAL_EMPLOYEE_UNIFIED_SCOPE || (stored === undefined && scope === "customer-profile");
  });
}

/** Digital-employee history lives in its own floating list. */
export function digitalEmployeeConversations<T extends Pick<Conversation, "agent_id">>(conversations: T[]): T[] {
  return conversations.filter((conversation) => conversation.agent_id === DIGITAL_EMPLOYEE_AGENT_ID);
}
