const TOKEN_KEY = "lot:token";
const USER_KEY = "lot:user";
const CONV_KEY = "lot:studioConversationId";

export interface SessionUser {
  id: string;
  name: string;
  username: string | null;
  phone: string | null;
}

export function getToken(): string {
  return String(wx.getStorageSync(TOKEN_KEY) || "");
}

export function getUser(): SessionUser | null {
  const raw = wx.getStorageSync(USER_KEY);
  return raw && typeof raw === "object" ? (raw as SessionUser) : null;
}

export function setSession(token: string, user: SessionUser): void {
  if (getUser()?.id !== user.id) clearAccountDrafts();
  wx.setStorageSync(TOKEN_KEY, token);
  wx.setStorageSync(USER_KEY, user);
  getApp().globalData.user = user;
}

export function clearSession(): void {
  wx.removeStorageSync(TOKEN_KEY);
  wx.removeStorageSync(USER_KEY);
  clearAccountDrafts();
  const app = getApp();
  app.globalData.user = null;
}

function clearAccountDrafts(): void {
  wx.removeStorageSync(CONV_KEY);
  const app = getApp();
  app.globalData.pendingRefs = [];
  app.globalData.posterJob = null;
  app.globalData.activeImageJob = null;
}

export function getStudioConversationId(): string {
  return String(wx.getStorageSync(CONV_KEY) || "");
}

export function setStudioConversationId(id: string): void {
  wx.setStorageSync(CONV_KEY, id);
}

export function clearStudioConversationId(): void {
  wx.removeStorageSync(CONV_KEY);
}

export function isBootPage(): boolean {
  const pages = getCurrentPages();
  const cur = pages[pages.length - 1];
  return cur?.route === "pages/boot/index";
}
