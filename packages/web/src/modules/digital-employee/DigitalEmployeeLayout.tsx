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
import { CustomerAcquisitionPage } from "./acquisition/CustomerAcquisitionPage.js";

interface DigitalEmployeeLayoutProps {
  pathname: string;
  user: User;
  onLogout: () => void;
  onNavigate: (path: string) => void;
  onOpenDigitalEmployee: () => void;
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

export function DigitalEmployeeLayout({ pathname, user, onLogout, onNavigate, onOpenDigitalEmployee, onNavigateAssistant, onOpenConversation }: DigitalEmployeeLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { conversations, loadingMore, hasMore, loadMore } = useConversations();
  const view = viewFor(pathname);
  const profileId = profileIdFor(pathname);
  const goProfiles = () => onNavigate("/digital-employee/profiles");
  const digitalEmployeeConversations = filterDigitalEmployeeConversations(conversations);
  const activeFeature: DigitalEmployeeFeature = view === "profiles" ? "customer-profile" : view;
  const activeScope = activeFeature === "copy" ? "customer-acquisition" : activeFeature === "acquisition" ? "opportunity-advisor" : activeFeature;
  const featureConversations = digitalEmployeeConversations.filter((conversation) => {
    const stored = conversation.metadata?.digitalEmployeeFeatureScope;
    return stored === activeScope || (stored === undefined && activeScope === "customer-profile");
  });
  const openFeature = (feature: DigitalEmployeeFeature) => onNavigate(`/digital-employee/${feature}`);
  const openFeatureChat = () => onNavigate(
    activeFeature === "copy" || activeFeature === "acquisition"
      ? `/digital-employee/${activeFeature}/chat`
      : `/digital-employee/${activeFeature}`
  );

  return (
    <div className="workspace de-workspace">
      <aside className={`workspace-sidebar de-workspace-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        <BrandHeader
          user={user}
          onLogout={onLogout}
          onCollapse={() => setSidebarCollapsed(true)}
          onOpenAssistant={onNavigateAssistant}
          onOpenDigitalEmployee={onOpenDigitalEmployee}
          activeModule="digitalEmployee"
        />
        <DigitalEmployeeSidebar
          activeFeature={activeFeature}
          conversations={featureConversations}
          onOpenFeature={openFeature}
          onOpenConversation={onOpenConversation}
          onNewConversation={openFeatureChat}
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
          {view === "copy" && <CustomerAcquisitionPage
            onOpenChat={openFeatureChat}
            onOpenMarketingMaterials={() => onNavigate("/digital-employee/marketing-materials/manage")}
          />}
        </div>
      </main>
    </div>
  );
}
