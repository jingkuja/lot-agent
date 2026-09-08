/** Stable, deliberately non-sensitive errors returned by the digital-employee API. */
export class DigitalEmployeeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "DigitalEmployeeError";
  }
}

export class InputError extends DigitalEmployeeError {
  constructor(message: string) {
    super(message, 400, "invalid_input");
  }
}

export class NotFoundError extends DigitalEmployeeError {
  constructor(message = "Not found") {
    super(message, 404, "not_found");
  }
}

export class ConflictError extends DigitalEmployeeError {
  constructor(message = "该记录已被其他窗口更新，请刷新后重试") {
    super(message, 409, "version_conflict");
  }
}

export class OpenTasksError extends DigitalEmployeeError {
  constructor(readonly openTaskCount: number) {
    super("该客户还有未完成的跟进任务，请选择取消或保留后再归档", 409, "open_tasks");
  }
}

export class ProductSelectionRequiredError extends InputError {
  constructor(
    readonly productName: string,
    readonly candidates: Array<{ id: string; name: string }>
  ) {
    super("请先确认要关联的营销产品");
    this.name = "ProductSelectionRequiredError";
  }
}

export class QuotaError extends DigitalEmployeeError {
  constructor(message = "当前余额不足，无法创建生成任务") {
    super(message, 402, "quota_exceeded");
  }
}

export function apiError(error: unknown): { status: number; body: { error: string; code?: string; openTaskCount?: number } } {
  if (error instanceof OpenTasksError) {
    return { status: error.status, body: { error: error.message, code: error.code, openTaskCount: error.openTaskCount } };
  }
  if (error instanceof DigitalEmployeeError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  console.error("digital-employee request failed", error);
  return { status: 500, body: { error: "数字员工资料服务暂时不可用", code: "internal_error" } };
}
