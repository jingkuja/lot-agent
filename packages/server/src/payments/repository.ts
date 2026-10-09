import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { VirtualPaymentOrder, VirtualPaymentRepository } from "@lot-agent/core";

type Row = {
  order_no: string; user_id: string; snapshot: VirtualPaymentOrder;
  status: VirtualPaymentOrder["status"]; refunded_fen: string; delivered: boolean;
};
function fromRow(row: Row): VirtualPaymentOrder {
  return { ...row.snapshot, orderNo: row.order_no, userId: row.user_id,
    status: row.status, refundedFen: Number(row.refunded_fen), delivered: row.delivered };
}

export class PgVirtualPaymentRepository implements VirtualPaymentRepository {
  constructor(private readonly pool: Pool) {}

  async create(order: VirtualPaymentOrder): Promise<void> {
    await this.pool.query(`INSERT INTO virtual_payment_orders (order_no, user_id, snapshot, next_check_at)
      VALUES ($1, $2, $3::jsonb, NOW() + INTERVAL '15 seconds')`, [order.orderNo, order.userId, JSON.stringify(order)]);
  }

  async findForUser(orderNo: string, userId: string): Promise<VirtualPaymentOrder | null> {
    const result = await this.pool.query<Row>("SELECT * FROM virtual_payment_orders WHERE order_no = $1 AND user_id = $2", [orderNo, userId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async due(limit: number): Promise<string[]> {
    const result = await this.pool.query<{ order_no: string }>(`SELECT order_no FROM virtual_payment_orders
      WHERE status IN ('pending','credited','sandbox_paid') AND next_check_at <= NOW() AND lease_until <= NOW()
      ORDER BY next_check_at LIMIT $1`, [limit]);
    return result.rows.map((row) => row.order_no);
  }

  async claim(orderNo: string) {
    const leaseId = randomUUID();
    const result = await this.pool.query<Row>(`UPDATE virtual_payment_orders SET lease_id = $2, lease_until = NOW() + INTERVAL '120 seconds'
      WHERE order_no = $1 AND next_check_at <= NOW() AND lease_until <= NOW()
      AND status IN ('pending','credited','sandbox_paid') RETURNING *`, [orderNo, leaseId]);
    return result.rows[0] ? { order: fromRow(result.rows[0]), leaseId } : null;
  }

  async finish(order: VirtualPaymentOrder, leaseId: string, delaySeconds: number): Promise<void> {
    // Fence stale workers; only the current lease can persist a result.
    await this.pool.query(`UPDATE virtual_payment_orders SET status = $3, refunded_fen = $4, delivered = $5,
      next_check_at = NOW() + $6 * INTERVAL '1 second', lease_until = NOW(), lease_id = NULL, updated_at = NOW()
      WHERE order_no = $1 AND lease_id = $2`, [order.orderNo, leaseId, order.status, order.refundedFen, order.delivered, delaySeconds]);
  }
}
