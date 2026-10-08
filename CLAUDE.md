# CLAUDE.md

## 按需阅读

- 需要了解项目功能、架构、代码入口或运行链路时，阅读 [项目架构与代码导航](docs/agent-code-guide.md)，再按任务查阅其中的专项文档。
- 已明确改动位置的小任务可直接阅读相关实现和测试，无需每次加载全部项目资料。
- 功能现状以当前代码与测试为准；命令以 `package.json` 为准，配置参考 `.env.example`。

## 开发约定

- 开始前检查 `git status --short`，保留用户已有修改；只改当前任务需要的内容。
- 使用 pnpm；TypeScript / ESM import 保留 `.js` 后缀，2 空格缩进。
- 依赖 DB / Redis 的能力在 core 定义接口、server 实现；不要给 core 引入 `pg` / `ioredis`。
- 数据库变更追加到 `packages/server/src/db/migrations/` 并在 `index.ts` 注册，不改已执行的历史迁移。PG `NUMERIC` 计算前显式转换。
- Web 颜色使用现有 CSS 变量，不硬编码 hex / rgba；检查暗色主题与中英文文案。
- 等待用户回复的交互工具使用 `endsTurn: true`，并同步前端卡片与消息持久化。

## 必须保持

- 服务端校验用户归属和工具执行白名单；模型凭证、计费及记忆按用户 / 请求隔离。
- 保留工具输入 schema 校验、文件沙箱、网络 SSRF 防护和取消机制；写工具不盲目重试。
- 密钥不提交 Git、不输出到客户端或日志；登录失败对客户端保持通用错误，生产禁用 `DEBUG=1`。

## 验证与交付

- 按改动范围运行相关测试与构建，说明实际验证结果；纯文档修改检查内容、路径和链接即可。
- 功能入口或架构改变时同步 `docs/agent-code-guide.md`；本文件只保留简短开发约定。
- `AGENTS.md` 与 `CLAUDE.md` 的约定保持一致。
