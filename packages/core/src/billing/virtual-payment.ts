/** Persistent payment ownership and immutable pricing/provider snapshots. */
export interface VirtualPaymentOrder {
  orderNo: string;
  userId: string;
  externalUserId: number;
  points: number;
  amountFen: number;
  appId: string;
  offerId: string;
  openid: string;
  productId: string;
  env: 0 | 1;
  createdAt: number;
  status: "pending" | "credited" | "sandbox_paid" | "refunded" | "payment_failed";
  refundedFen: number;
  delivered: boolean;
}

export interface VirtualPaymentRepository {
  create(order: VirtualPaymentOrder): Promise<void>;
  findForUser(orderNo: string, userId: string): Promise<VirtualPaymentOrder | null>;
  due(limit: number): Promise<string[]>;
  claim(orderNo: string): Promise<{ order: VirtualPaymentOrder; leaseId: string } | null>;
  finish(order: VirtualPaymentOrder, leaseId: string, delaySeconds: number): Promise<void>;
}
