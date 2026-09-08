import type { Agent, Conversation } from "../api/client.js";

export const DIGITAL_EMPLOYEE_AGENT_ID = "digital_employee";

/** The digital employee is a product module, never a normal installable Agent. */
export function withoutDigitalEmployee<T extends Pick<Agent, "id">>(agents: T[]): T[] {
  return agents.filter((agent) => agent.id !== DIGITAL_EMPLOYEE_AGENT_ID);
}

/** Digital-employee history lives in its own floating list. */
export function digitalEmployeeConversations<T extends Pick<Conversation, "agent_id">>(conversations: T[]): T[] {
  return conversations.filter((conversation) => conversation.agent_id === DIGITAL_EMPLOYEE_AGENT_ID);
}
