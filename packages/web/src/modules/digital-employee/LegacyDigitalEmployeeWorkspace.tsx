import type { User } from "../../api/client.js";
import type { ModelCatalog } from "../../hooks/useModels.js";
import { Workspace, type WorkspaceContext } from "../../pages/Workspace.js";
import {
  DIGITAL_EMPLOYEE_AGENT_ID,
  DIGITAL_EMPLOYEE_UNIFIED_SCOPE,
  digitalEmployeeConversations,
  digitalEmployeeConversationsForScope,
} from "./conversation-scope.js";
import { CustomerAcquisitionChatHome } from "./acquisition/CustomerAcquisitionChatHome.js";
import { DigitalEmployeeActions } from "./DigitalEmployeeActions.js";
import { DigitalEmployeeHome } from "./DigitalEmployeeHome.js";
import { DigitalEmployeeSidebar, type DigitalEmployeeFeature } from "./DigitalEmployeeSidebar.js";
import { employeeApi } from "./api.js";
import { readConversationFocus } from "./focus.js";
import { MarketingMaterialsHome } from "./marketing/MarketingMaterialsHome.js";
import { OpportunityAdvisorChatHome } from "./opportunities/OpportunityAdvisorChatHome.js";

interface LegacyProps {
  user: User;
  modelCatalog: ModelCatalog;
  onLogout: () => void;
  feature: DigitalEmployeeFeature;
  unifiedEnabled: boolean;
  onNavigateAssistant: () => void;
  onOpenManagement: () => void;
  onOpenProfile: (id: string) => void;
  onOpenFeature: (feature: DigitalEmployeeFeature) => void;
  requestedConversationId: string | null;
  onRequestedConversationHandled: () => void;
}

function scopeFor(feature: DigitalEmployeeFeature): string {
  if (feature === "copy") return "customer-acquisition";
  return feature === "acquisition" ? "opportunity-advisor" : feature;
}

const isUnified = (conversation: WorkspaceContext["activeConversation"]) =>
  conversation?.metadata?.digitalEmployeeFeatureScope === DIGITAL_EMPLOYEE_UNIFIED_SCOPE;

/** The four-module interface, kept behind the workspace switch until it is removed. */
export function LegacyDigitalEmployeeWorkspace({
  user, modelCatalog, onLogout, feature, unifiedEnabled, onNavigateAssistant, onOpenManagement, onOpenProfile, onOpenFeature,
  requestedConversationId, onRequestedConversationHandled,
}: LegacyProps) {
  const unifiedFor = (context: WorkspaceContext) => context.activeConversation ? isUnified(context.activeConversation) : unifiedEnabled;
  return <Workspace
    user={user}
    modelCatalog={modelCatalog}
    onLogout={onLogout}
    lockedAgentId={DIGITAL_EMPLOYEE_AGENT_ID}
    newConversationScope={scopeFor(feature)}
    resetKey={feature}
    keepConversation={isUnified}
    onNavigateAssistant={onNavigateAssistant}
    onNavigateDigitalEmployee={() => {}}
    requestedConversationId={requestedConversationId}
    onRequestedConversationHandled={onRequestedConversationHandled}
    sidebar={(context) => <DigitalEmployeeSidebar
      activeFeature={feature}
      conversations={digitalEmployeeConversationsForScope(digitalEmployeeConversations(context.conversations), scopeFor(feature))}
      activeConversationId={context.activeConversationId}
      onOpenFeature={(next) => {
        if (next === feature) context.newConversation();
        else onOpenFeature(next);
      }}
      onOpenConversation={context.openConversation}
      onNewConversation={context.newConversation}
      onDeleteConversation={context.deleteConversation}
      onLoadMore={context.loadMore}
      hasMore={context.hasMore}
      loadingMore={context.loadingMore}
    />}
    inputAbove={(context) => {
      const { activeConversationId, activeConversation, refreshConversations } = context;
      const focus = readConversationFocus(activeConversation?.metadata);
      return <DigitalEmployeeActions
        feature={feature}
        unified={unifiedFor(context)}
        onOpenProfiles={onOpenManagement}
        currentCustomerName={focus?.type === "customer" ? focus.label : null}
        onClearCurrentCustomer={activeConversationId ? () => {
          void employeeApi.clearDigitalEmployeeContext(activeConversationId).then(refreshConversations).catch(() => {});
        } : undefined}
      />;
    }}
    emptyDashboard={(context) => {
      const unified = unifiedFor(context);
      if (feature === "marketing-materials") return <MarketingMaterialsHome onOpenManagement={onOpenManagement} onPrompt={context.send} />;
      if (feature === "copy") return <CustomerAcquisitionChatHome unified={unified} onOpenWorkspace={onOpenManagement} onPrompt={context.send} />;
      if (feature === "acquisition") return <OpportunityAdvisorChatHome unified={unified} onOpenWorkspace={onOpenManagement} onPrompt={context.send} />;
      return <DigitalEmployeeHome
        onOpenProfiles={onOpenManagement}
        onOpenProfile={onOpenProfile}
        onOpenOpportunities={() => onOpenFeature("acquisition")}
        onOpenAcquisition={() => onOpenFeature("copy")}
        onPrompt={context.send}
      />;
    }}
  />;
}
