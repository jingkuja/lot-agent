import type { Migration } from "../migration-runner.js";

export const userWechat: Migration = {
  version: 22,
  name: "user-wechat",
  async up(client) {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS wechat_openid VARCHAR(64),
        ADD COLUMN IF NOT EXISTS wechat_unionid VARCHAR(64);
      CREATE UNIQUE INDEX IF NOT EXISTS users_wechat_openid_uidx
        ON users (wechat_openid)
        WHERE wechat_openid IS NOT NULL;
    `);
  },
};
