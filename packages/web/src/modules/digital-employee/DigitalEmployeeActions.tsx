import type { DigitalEmployeeFeature } from "./DigitalEmployeeSidebar.js";

interface DigitalEmployeeActionsProps {
  feature?: DigitalEmployeeFeature;
  onOpenProfiles: () => void;
  currentCustomerName?: string | null;
  onClearCurrentCustomer?: () => void;
}

/** Lightweight precision-management entry shown only above digital-employee chat. */
export function DigitalEmployeeActions({
  feature = "customer-profile",
  onOpenProfiles,
  currentCustomerName,
  onClearCurrentCustomer,
}: DigitalEmployeeActionsProps) {
  const isMarketing = feature === "marketing-materials";
  return (
    <div className="de-chat-actions" aria-label="数字员工快捷操作">
      <p className="de-chat-actions-hint">
        <span className="de-chat-actions-hint-icon" aria-hidden>✦</span>
        <span>{isMarketing ? "直接在下方对话中快速维护产品卖点、权益、案例和品牌口径" : "直接在下方对话中快速创建、查询、补充和更新客户画像"}</span>
      </p>
      <div className="de-chat-actions-row">
        <button type="button" className="de-chat-management-button" onClick={onOpenProfiles}>
          <span aria-hidden>{isMarketing ? "◆" : "◎"}</span>
          {isMarketing ? "营销资料管理" : "客户画像管理"}
        </button>
        {!isMarketing && currentCustomerName && (
          <span className="de-chat-current-customer">
            当前客户：<strong>{currentCustomerName}</strong>
            {onClearCurrentCustomer && (
              <button type="button" onClick={onClearCurrentCustomer} aria-label="清除当前客户">×</button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
