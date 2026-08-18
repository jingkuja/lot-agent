interface DigitalEmployeeActionsProps {
  onOpenProfiles: () => void;
  currentCustomerName?: string | null;
  onClearCurrentCustomer?: () => void;
}

/** Lightweight precision-management entry shown only above digital-employee chat. */
export function DigitalEmployeeActions({
  onOpenProfiles,
  currentCustomerName,
  onClearCurrentCustomer,
}: DigitalEmployeeActionsProps) {
  return (
    <div className="de-chat-actions" aria-label="数字员工快捷操作">
      <button type="button" className="de-chat-management-button" onClick={onOpenProfiles}>
        <span aria-hidden>◎</span>
        客户画像管理
      </button>
      {currentCustomerName ? (
        <span className="de-chat-current-customer">
          当前客户：<strong>{currentCustomerName}</strong>
          {onClearCurrentCustomer && (
            <button type="button" onClick={onClearCurrentCustomer} aria-label="清除当前客户">×</button>
          )}
        </span>
      ) : (
        <span className="de-chat-actions-hint">批量筛选、联系方式、字段锁定和审计</span>
      )}
    </div>
  );
}
