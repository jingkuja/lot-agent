import type { Conversation } from "../../api/client.js";

export const DIGITAL_EMPLOYEE_AGENT_ID = "digital_employee";
export const DIGITAL_EMPLOYEE_UNIFIED_SCOPE = "employee";

/** The work log lists these, and the assistant never does. */
export function digitalEmployeeConversations<T extends Pick<Conversation, "agent_id">>(conversations: T[]): T[] {
  return conversations.filter((conversation) => conversation.agent_id === DIGITAL_EMPLOYEE_AGENT_ID);
}
