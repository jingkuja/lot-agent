import { api } from "./services/api";
import {
  clearSession,
  clearWechatTicket,
  getToken,
  getUser,
  setSession,
  setWechatTicket,
} from "./services/session";

App({
  globalData: {
    user: null as LotUser | null,
    debug: false,
    wechatLogin: false,
    managedRegistration: false,
    pendingRefs: [] as string[],
    posterJob: null as { id: string; topic: string } | null,
  },

  onLaunch() {
    this.globalData.user = getUser();
    void this.bootstrap();
  },

  async bootstrap() {
    try {
      const mode = await api.mode();
      this.globalData.debug = mode.debug === true;
      this.globalData.wechatLogin = mode.wechatLogin === true;
      this.globalData.managedRegistration = mode.managedRegistration === true;
      if (mode.debug) {
        this.enterStudio();
        return;
      }
      if (getToken()) {
        try {
          const user = await api.me();
          setSession(getToken(), user);
          await this.bindPendingWechat();
          this.enterStudio();
          return;
        } catch {
          clearSession();
        }
      }
      if (mode.wechatLogin) {
        const signedIn = await this.tryWechatLogin();
        if (signedIn) {
          this.enterStudio();
          return;
        }
      }
    } catch {
      // Stay on the login page; the form still works once the server is reachable.
    }
  },

  async ensureSession(): Promise<boolean> {
    if (this.globalData.debug) return true;
    if (getToken()) return true;
    this.sendToLogin();
    return false;
  },

  enterStudio() {
    wx.switchTab({ url: "/pages/studio/index" });
  },

  sendToLogin() {
    if (getCurrentPages().some((p) => p.route === "pages/login/index")) return;
    wx.reLaunch({ url: "/pages/login/index" });
  },

  async tryWechatLogin(): Promise<boolean> {
    const code = await new Promise<string>((resolve, reject) => {
      wx.login({
        success: (res) => (res.code ? resolve(res.code) : reject(new Error("no code"))),
        fail: (err) => reject(new Error(err.errMsg)),
      });
    }).catch(() => "");
    if (!code) return false;
    try {
      const result = await api.wechatLogin(code);
      if (result.token && result.user) {
        setSession(result.token, result.user);
        clearWechatTicket();
        return true;
      }
      if (result.needBind && result.ticket) {
        setWechatTicket(result.ticket);
      }
    } catch {
      // Fall through to the phone / password form.
    }
    return false;
  },

  async bindPendingWechat() {
    const ticket = String(wx.getStorageSync("lot:wechatTicket") || "");
    if (!ticket || !this.globalData.wechatLogin) return;
    try {
      await api.wechatBind({ ticket });
      clearWechatTicket();
    } catch {
      // Bind is best-effort; silent login still works next time if it succeeded server-side.
    }
  },
});
