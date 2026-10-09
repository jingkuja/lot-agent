import type { Migration } from "../migration-runner.js";

export const virtualPayment: Migration = {
  // Version 32 is already used by comic-drama in an existing database.
  version: 33,
  name: "virtual-payment",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS virtual_payment_orders (
        order_no VARCHAR(32) PRIMARY KEY,
        user_id VARCHAR(100) NOT NULL,
        snapshot JSONB NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        refunded_fen BIGINT NOT NULL DEFAULT 0 CHECK (refunded_fen >= 0),
        delivered BOOLEAN NOT NULL DEFAULT FALSE,
        next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_id TEXT,
        lease_until TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (status IN ('pending','credited','sandbox_paid','refunded','payment_failed'))
      );
      CREATE INDEX IF NOT EXISTS virtual_payment_owner_idx ON virtual_payment_orders(user_id, order_no);
      CREATE INDEX IF NOT EXISTS virtual_payment_due_idx ON virtual_payment_orders(next_check_at)
        WHERE status IN ('pending','credited','sandbox_paid');
    `);
  },
};
