/** Tool names that indicate an agent can use the memory system. */
const MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_write",
  "memory_list",
  "memory_delete",
];

/**
 * Whether the agent's tool whitelist grants access to memory tools.
 * `undefined` means "all tools allowed" → true.
 */
export function hasMemoryTools(names?: string[]): boolean {
  if (!names) return true;
  return names.some((n) => MEMORY_TOOL_NAMES.includes(n));
}

/** Strategy block injected into the system prompt for memory-capable agents. */
export const MEMORY_POLICY_PROMPT = `[记忆使用策略]
你有三层记忆，通过 memory_read / memory_write / memory_list / memory_delete 工具访问：
- user（持久）：写入跨会话长期有效的用户事实与稳定偏好，例如称呼、语言偏好、行业/品牌背景、长期约束。仅在用户明确表达或可稳妥推断的稳定信息时写入；不要写一次性请求、临时上下文或敏感信息（密码、支付信息）。
- session（会话）：写入仅在当前对话内有用的状态，例如待确认事项、当前任务的中间决定。20 分钟无活动后过期。
- ephemeral（工作）：单次回合内的临时中间结果，无需手动管理。

规则：
1. 写入前先用 memory_list 或 memory_read 查看，避免重复；同一事实用相同 key 覆盖更新，不要堆积近义条目。
2. 当用户更正信息、偏好变化或某条记忆明显过时，用 memory_write 覆盖或 memory_delete 删除，保持记忆精炼、无矛盾。
3. user 记忆的 key 用稳定的英文 snake_case（如 preferred_language、brand_name）。
4. 不要为了写而写：没有长期价值的内容不要进入 user。`;
