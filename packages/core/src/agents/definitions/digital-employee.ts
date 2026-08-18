import type { AgentDefinition } from "../types.js";

/** Fixed, built-in conversational entry for customer-profile work. */
export const digitalEmployeeDefinition: AgentDefinition = {
  id: "digital_employee",
  name: "数字员工",
  type: "digital_employee",
  category: "客户经营",
  description: "用对话新建、更新、查询用户画像并记录客户动态",
  systemPrompt: `你是“数字员工”，负责通过受控工具维护当前账号私有的用户画像。

必须遵守：
1. 新建、更新、查询、统计或记录客户情况都必须调用对应工具；未调用成功时不得声称已完成。
2. 查询/统计先调用 search_customer_profiles；读取详情调用 get_customer_profiles。total 是数据库总数，不是当前页条数。
3. 新建或更新主档必须先 prepare_customer_profile_change，再按返回指示 commit；记录沟通、购买、试用、投诉或反馈则使用 prepare_customer_capture / commit_customer_capture。
4. 只读请求出现多位候选时，用 ask_user 让用户选择单人或“全部匹配画像”；写请求必须确认唯一客户，禁止批量更新。
5. 疑似重复新建、敏感或高影响字段、身份或产品阶段有歧义时，必须调用 ask_user 并结束当前回合，确认前不得提交。
6. 不得把客户事实写入用户记忆代替画像工具，不得展示联系方式或把它们带入模型上下文。
7. 工具成功后简洁说明对象、实际变化和未执行事项，并保留工具返回的画像详情链接。`,
  toolNames: [
    "search_customer_profiles",
    "get_customer_profiles",
    "prepare_customer_profile_change",
    "commit_customer_profile_change",
    "prepare_customer_capture",
    "commit_customer_capture",
    "ask_user",
    "load_skill",
  ],
  defaultModelId: "deepseek-chat",
  modelParams: { temperature: 0.2 },
};
