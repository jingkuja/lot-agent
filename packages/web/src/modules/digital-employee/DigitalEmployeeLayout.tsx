import { useState } from "react";
import type { User } from "../../api/client.js";
import { BrandHeader } from "../../components/BrandHeader.js";
import { useConversations } from "../../hooks/useConversations.js";
import { digitalEmployeeConversations as filterDigitalEmployeeConversations } from "../../lib/product-agent-scope.js";
import { DigitalEmployeeSidebar, type DigitalEmployeeFeature } from "./DigitalEmployeeSidebar.js";
import { ProfileDetailPage } from "./profiles/ProfileDetailPage.js";
import { ProfileListPage } from "./profiles/ProfileListPage.js";
import { MarketingMaterialsPage } from "./marketing/MarketingMaterialsPage.js";
import { OpportunityAdvisorPage } from "./opportunities/OpportunityAdvisorPage.js";

interface DigitalEmployeeLayoutProps {
  pathname: string;
  user: User;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onNavigateAssistant: () => void;
  onOpenConversation: (id: string) => void;
}

type View = "marketing-materials" | "profiles" | "acquisition" | "copy";

function viewFor(pathname: string): View {
  if (pathname.startsWith("/digital-employee/marketing-materials")) return "marketing-materials";
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
  const openFeature = (feature: DigitalEmployeeFeature) => onNavigate(`/digital-employee/${feature}`);

  return (
    <div className="workspace de-workspace">
      <aside className={`workspace-sidebar de-workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCollapse={() => setSidebarCollapsed(true)}
          onOpenAssistant={onNavigateAssistant}
          onOpenDigitalEmployee={() => onNavigate("/digital-employee/marketing-materials")}
          activeModule="digitalEmployee"
        />
        <DigitalEmployeeSidebar
          activeFeature={activeFeature}
          conversations={digitalEmployeeConversations}
          onOpenFeature={openFeature}
          onOpenConversation={onOpenConversation}
          onNewConversation={() => onNavigate(view === "marketing-materials" ? "/digital-employee/marketing-materials" : "/digital-employee/customer-profile")}
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
            : <ProfileListPage
              onOpenProfile={(id) => onNavigate(`/digital-employee/profiles/${encodeURIComponent(id)}`)}
              onBackToConversation={() => onNavigate("/digital-employee/customer-profile")}
            />)}
          {view === "marketing-materials" && <MarketingMaterialsPage onBackToConversation={() => onNavigate("/digital-employee/marketing-materials")} />}
          {view === "acquisition" && <OpportunityAdvisorPage
            onOpenProfile={(id) => onNavigate(`/digital-employee/profiles/${encodeURIComponent(id)}`)}
            onCreateProfile={goProfiles}
          />}
          {view === "copy" && <ComingSoon title="获客宝" description="围绕整体客群洞察与产品匹配生成营销文案、海报和视频；客群营销工作台将在下一阶段接入。" onBack={goProfiles} />}
        </div>
      </main>
    </div>
  );
}

function ComingSoon({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  return <div className="de-page de-coming-soon"><span aria-hidden>◌</span><h1>{title}</h1><p>{description}</p><button className="de-secondary-button" onClick={onBack}>查看客户画像</button></div>;
}
