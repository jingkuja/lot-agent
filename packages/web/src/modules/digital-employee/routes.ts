/** Every location of the employee workspace. `view` decides which page covers the chat. */
export type EmployeeView = "today" | "customers" | "marketing" | "materials" | "work-log" | "schedule" | "chat";

export const EMPLOYEE_ROOT = "/digital-employee";
export const TODAY_PATH = `${EMPLOYEE_ROOT}/today`;
export const CHAT_PATH = `${EMPLOYEE_ROOT}/chat`;

export interface EmployeeLocation {
  view: EmployeeView;
  /** The tab or object in the path after the view. */
  tab: string | null;
  conversationId: string | null;
  profileId: string | null;
  /** The conversation whose work record is open. */
  workConversationId: string | null;
  /** The scheduled run whose report is open. */
  scheduledRunId: string | null;
  /** The file import whose review is open. */
  importId: string | null;
}

const CUSTOMER_TABS = new Set(["segments"]);
const WORK_TABS = new Set(["conversations", "in_progress", "completed", "snoozed", "scheduled"]);

export function employeePath(view: EmployeeView, tail?: string): string {
  return `${EMPLOYEE_ROOT}/${view}${tail ? `/${encodeURIComponent(tail)}` : ""}`;
}

export function parseEmployeePath(pathname: string): EmployeeLocation {
  const [view = "today", tail = null, item = null] = pathname.slice(EMPLOYEE_ROOT.length + 1).split("/").filter(Boolean);
  const decoded = tail === null ? null : decodeURIComponent(tail);
  const base = { tab: null, conversationId: null, profileId: null, workConversationId: null, scheduledRunId: null, importId: null };
  if (view === "chat") return { ...base, view, conversationId: decoded };
  if (view === "customers") {
    return CUSTOMER_TABS.has(decoded ?? "") ? { ...base, view, tab: decoded } : { ...base, view, profileId: decoded };
  }
  if (view === "marketing") return { ...base, view, tab: decoded };
  if (view === "work-log") {
    if (decoded && !WORK_TABS.has(decoded)) return { ...base, view, workConversationId: decoded };
    return { ...base, view, tab: decoded, scheduledRunId: item === null ? null : decodeURIComponent(item) };
  }
  if (view === "materials") return { ...base, view, importId: decoded === "import" && item !== null ? decodeURIComponent(item) : null };
  if (view === "schedule") return { ...base, view };
  return { ...base, view: "today" };
}

/** Old links, bookmarks and past chat messages keep working. Longest prefix first. */
const OLD_PATHS: Array<[old: string, next: string]> = [
  ["/digital-employee/marketing-materials", "/digital-employee/materials"],
  ["/digital-employee/customer-profile", "/digital-employee/today"],
  ["/digital-employee/profiles", "/digital-employee/customers"],
  ["/digital-employee/acquisition", "/digital-employee/today"],
  ["/digital-employee/follow-ups", "/digital-employee/today"],
  ["/digital-employee/copy", "/digital-employee/marketing"],
];

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

function isChatTail(pathname: string, old: string): boolean {
  return pathname === `${old}/chat`;
}

/** Where an address lives now; returns it unchanged when it is already current. */
export function normalizeEmployeePath(pathname: string): string {
  if (!matches(pathname, EMPLOYEE_ROOT)) return pathname;
  if (pathname === EMPLOYEE_ROOT) return TODAY_PATH;
  const hit = OLD_PATHS.find(([old]) => matches(pathname, old));
  if (!hit) return pathname;
  if (isChatTail(pathname, hit[0])) return hit[0] === "/digital-employee/copy" ? CHAT_PATH : TODAY_PATH;
  // Only customer pages keep what follows: `/profiles/:id` is still that customer.
  return hit[0] === "/digital-employee/profiles" ? pathname.replace(hit[0], hit[1]) : hit[1];
}
