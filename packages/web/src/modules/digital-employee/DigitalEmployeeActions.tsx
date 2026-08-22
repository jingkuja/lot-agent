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
  const isOpportunity = feature === "acquisition";
  const isAcquisition = feature === "copy";
  const hint = isMarketing
    ? "直接在下方对话中快速维护产品卖点、权益、案例和品牌口径"
    : isOpportunity
      ? "商机雷达对话只处理单个客户：查询今日队列、采纳商机、创建或改期行动、生成话术并回填结果"
      : isAcquisition
        ? "获客宝对话只处理客群：保存客群、创建活动、改写素材、标记投放并回填群体结果"
        : "直接在下方对话中快速创建、查询、补充和更新客户画像";
  const management = isMarketing ? ["◆", "营销资料管理"] : isOpportunity ? ["◇", "商机雷达工作台"] : isAcquisition ? ["✎", "获客宝工作台"] : ["◎", "客户画像管理"];
  return (
    <div className="de-chat-actions" aria-label="数字员工快捷操作">
      <p className="de-chat-actions-hint">
        <span className="de-chat-actions-hint-icon" aria-hidden>✦</span>
        <span>{hint}</span>
      </p>
      <div className="de-chat-actions-row">
        <button type="button" className="de-chat-management-button" onClick={onOpenProfiles}>
          <span aria-hidden>{management[0]}</span>
          {management[1]}
        </button>
        {isAcquisition && <span className="de-chat-current-customer">当前作用域：<strong>获客宝 · 客群 / 公开受众</strong></span>}
        {!isMarketing && !isAcquisition && currentCustomerName && (
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
