import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/index.js";
import { CustomerSegmentsPage } from "./acquisition/CustomerSegmentsPage.js";
import { employeeApi } from "./api.js";
import type { EmployeeFocus } from "./focus.js";
import { formatTime } from "./opportunities/OpportunityCard.js";
import { ProfileDetailPage } from "./profiles/ProfileDetailPage.js";
import { ProfileListPage } from "./profiles/ProfileListPage.js";
import type { CustomerSegment, CustomerWork } from "./types.js";

interface CustomersPageProps {
  employeeName: string;
  tab: string | null;
  profileId: string | null;
  onNavigate: (tail?: string) => void;
  onFocus: (focus: EmployeeFocus | null) => void;
  onCreateContent: (segment: CustomerSegment) => void;
  onDraftOutreach: (profile: { id: string; displayName: string }) => void;
}

/** Customer records and customer groups, one entry for everything about people. */
export function CustomersPage({ employeeName, tab, profileId, onNavigate, onFocus, onCreateContent, onDraftOutreach }: CustomersPageProps) {
  const { t } = useI18n();
  const [customerName, setCustomerName] = useState("");
  if (profileId) {
    return <ProfileDetailPage
      profileId={profileId}
      onBack={() => onNavigate()}
      onLoaded={(profile) => {
        setCustomerName(profile.displayName);
        onFocus({ type: "customer", id: profile.id, label: profile.displayName });
      }}
    >
      <CustomerWorkPanel
        profileId={profileId}
        employeeName={employeeName}
        onDraftOutreach={customerName ? () => onDraftOutreach({ id: profileId, displayName: customerName }) : undefined}
      />
    </ProfileDetailPage>;
  }
  return <div className="de-employee-page-tabs">
    <nav className="de-employee-tabs" aria-label={t("客户")}>
      <button className={tab ? "" : "active"} onClick={() => onNavigate()}>{t("客户档案")}</button>
      <button className={tab === "segments" ? "active" : ""} onClick={() => onNavigate("segments")}>{t("客群")}</button>
    </nav>
    {tab === "segments"
      ? <div className="de-page"><CustomerSegmentsPage
        onCreateContent={onCreateContent}
        onSelect={(segment) => onFocus({ type: "segment", id: segment.id, label: segment.name })}
      /></div>
      : <ProfileListPage onOpenProfile={onNavigate} />}
  </div>;
}

/** What the employee suggests for this customer and what was done lately. */
function CustomerWorkPanel({ profileId, employeeName, onDraftOutreach }: {
  profileId: string;
  employeeName: string;
  onDraftOutreach?: () => void;
}) {
  const { t, locale } = useI18n();
  const [work, setWork] = useState<CustomerWork | null>(null);
  useEffect(() => {
    let active = true;
    setWork(null);
    void employeeApi.getCustomerWork(profileId).then((result) => { if (active) setWork(result); }).catch(() => {});
    return () => { active = false; };
  }, [profileId]);
  if (!work) return null;
  const suggestions = work.opportunities.slice(0, 3);
  const recent = work.actions.slice(0, 3);
  return <section className="de-customer-work" aria-label={t("员工的建议和最近工作")}>
    <header>
      <strong>{t("{0}的建议", [employeeName])}</strong>
      {onDraftOutreach && <button type="button" className="de-secondary-button" onClick={onDraftOutreach}>{t("写话术")}</button>}
    </header>
    {suggestions.length === 0 && recent.length === 0 && <p>{t("暂时没有要跟进的事。")}</p>}
    {suggestions.map((item) => <p key={item.id}><b>{item.title}</b><span>{item.reason}</span></p>)}
    {recent.length > 0 && <h4>{t("最近工作")}</h4>}
    {recent.map((item) => <p key={item.id}>
      <b>{item.title}</b>
      <span>{item.scheduledAt ? formatTime(item.scheduledAt, locale) : ""}</span>
    </p>)}
    {work.outreach.length > 0 && <h4>{t("最近话术")}</h4>}
    {work.outreach.slice(0, 2).map((item) => <p key={item.id}><span>{item.excerpt}</span></p>)}
  </section>;
}
