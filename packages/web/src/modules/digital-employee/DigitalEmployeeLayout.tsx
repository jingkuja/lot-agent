import { useState } from "react";
import type { User } from "../../api/client.js";
import { BrandHeader } from "../../components/BrandHeader.js";
import { useConversations } from "../../hooks/useConversations.js";
import { digitalEmployeeConversations as filterDigitalEmployeeConversations } from "../../lib/product-agent-scope.js";
import { DigitalEmployeeSidebar, type DigitalEmployeeFeature } from "./DigitalEmployeeSidebar.js";
import { ProfileDetailPage } from "./profiles/ProfileDetailPage.js";
import { ProfileListPage } from "./profiles/ProfileListPage.js";

interface DigitalEmployeeLayoutProps {
  pathname: string;
  user: User;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onNavigateAssistant: () => void;
  onOpenConversation: (id: string) => void;
}

type View = "profiles" | "acquisition" | "copy";

function viewFor(pathname: string): View {
  if (pathname.startsWith("/digital-employee/acquisition") || pathname.startsWith("/digital-employee/follow-ups")) return "acquisition";
  if (pathname.startsWith("/digital-employee/copy")) return "copy";
  return "profiles";
}

function profileIdFor(pathname: string): string | null {
  const match = pathname.match(/^\/digital-employee\/profiles\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function DigitalEmployeeLayout({ pathname, user, onLogout, onNavigate, onNavigateAssistant, onOpenConversation }: DigitalEmployeeLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { conversations, loadingMore, hasMore, loadMore } = useConversations();
  const view = viewFor(pathname);
  const profileId = profileIdFor(pathname);
  const goProfiles = () => onNavigate("/digital-employee/profiles");
  const digitalEmployeeConversations = filterDigitalEmployeeConversations(conversations);
  const activeFeature: DigitalEmployeeFeature = view === "profiles" ? "customer-profile" : view;
  const openFeature = (feature: DigitalEmployeeFeature) => {
    if (feature === "customer-profile") onNavigate("/digital-employee/customer-profile");
    else onNavigate(`/digital-employee/${feature}`);
  };

  return (
    <div className="workspace de-workspace">
      <aside className={`workspace-sidebar de-workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCollapse={() => setSidebarCollapsed(true)}
          onOpenAssistant={onNavigateAssistant}
          onOpenDigitalEmployee={() => onNavigate("/digital-employee/customer-profile")}
          activeModule="digitalEmployee"
        />
        <DigitalEmployeeSidebar
          activeFeature={activeFeature}
          conversations={digitalEmployeeConversations}
          onOpenFeature={openFeature}
          onOpenConversation={onOpenConversation}
          onNewConversation={() => onNavigate("/digital-employee/customer-profile")}
          loadingMore={loadingMore}
          hasMore={hasMore}
          onLoadMore={loadMore}
        />
      </aside>

      <main className="workspace-main de-workspace-main">
        {sidebarCollapsed && <button className="sidebar-expand" onClick={() => setSidebarCollapsed(false)} title="展开侧栏" aria-label="展开侧栏">›</button>}
        <div className="de-main-surface">
          {view === "profiles" && (profileId
            ? <ProfileDetailPage profileId={profileId} onBack={goProfiles} />
            : <ProfileListPage onOpenProfile={(id) => onNavigate(`/digital-employee/profiles/${encodeURIComponent(id)}`)} />)}
          {view === "acquisition" && <ComingSoon title="获客宝" description="线索发现、客户分层与跟进建议将在下一阶段接入；客户画像继续作为事实来源。" onBack={goProfiles} />}
          {view === "copy" && <ComingSoon title="营销文案" description="画像摘要与脱敏上下文已准备完成；文案项目和版本工作台将在下一阶段接入。" onBack={goProfiles} />}
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  return <div className="de-page de-coming-soon"><span aria-hidden>◌</span><h1>{title}</h1><p>{description}</p><button className="de-secondary-button" onClick={onBack}>查看用户画像</button></div>;
}
