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

export class QuotaError extends DigitalEmployeeError {
  constructor(message = "当前余额不足，无法创建生成任务") {
    super(message, 402, "quota_exceeded");
  }
}

export function apiError(error: unknown): { status: number; body: { error: string; code?: string } } {
  if (error instanceof DigitalEmployeeError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  console.error("digital-employee request failed", error);
  return { status: 500, body: { error: "数字员工资料服务暂时不可用", code: "internal_error" } };
}
