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
}

const CUSTOMER_TABS = new Set(["segments"]);

export function employeePath(view: EmployeeView, tail?: string): string {
  return `${EMPLOYEE_ROOT}/${view}${tail ? `/${encodeURIComponent(tail)}` : ""}`;
}

export function parseEmployeePath(pathname: string): EmployeeLocation {
  const [view = "today", tail = null] = pathname.slice(EMPLOYEE_ROOT.length + 1).split("/").filter(Boolean);
  const decoded = tail === null ? null : decodeURIComponent(tail);
  const base = { tab: null, conversationId: null, profileId: null };
  if (view === "chat") return { ...base, view, conversationId: decoded };
  if (view === "customers") {
    return CUSTOMER_TABS.has(decoded ?? "") ? { ...base, view, tab: decoded } : { ...base, view, profileId: decoded };
  }
  if (view === "marketing") return { ...base, view, tab: decoded };
  if (view === "work-log") return { ...base, view, tab: decoded };
  if (view === "materials" || view === "schedule") return { ...base, view };
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

/** Tool links always use the new paths, so the older interface maps them back while it exists. */
const NEW_PATHS: Array<[next: string, old: string]> = [
  ["/digital-employee/today", "/digital-employee/acquisition"],
  ["/digital-employee/customers/segments", "/digital-employee/copy"],
  ["/digital-employee/customers", "/digital-employee/profiles"],
  ["/digital-employee/marketing", "/digital-employee/copy"],
  ["/digital-employee/materials", "/digital-employee/marketing-materials/manage"],
  ["/digital-employee/work-log", "/digital-employee/customer-profile"],
  ["/digital-employee/schedule", "/digital-employee/customer-profile"],
  ["/digital-employee/chat", "/digital-employee/customer-profile"],
];

const matches = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

function isChatTail(pathname: string, old: string): boolean {
  return pathname === `${old}/chat`;
}

/** The current path under the interface in use; returns the path unchanged when it already fits. */
export function normalizeEmployeePath(pathname: string, workspace: boolean): string {
  if (!matches(pathname, EMPLOYEE_ROOT)) return pathname;
  if (workspace) {
    if (pathname === EMPLOYEE_ROOT) return TODAY_PATH;
    const hit = OLD_PATHS.find(([old]) => matches(pathname, old));
    if (!hit) return pathname;
    if (isChatTail(pathname, hit[0])) return hit[0] === "/digital-employee/copy" ? CHAT_PATH : TODAY_PATH;
    // Only customer pages keep what follows: `/profiles/:id` is still that customer.
    return hit[0] === "/digital-employee/profiles" ? pathname.replace(hit[0], hit[1]) : hit[1];
  }
  const hit = NEW_PATHS.find(([next]) => matches(pathname, next));
  if (!hit) return pathname;
  return hit[0] === "/digital-employee/customers" ? pathname.replace(hit[0], hit[1]) : hit[1];
}
