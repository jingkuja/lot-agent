import { loginDiagnostic } from "./services/login-diagnostic";
import { api } from "./services/api";
import {
  clearSession,
  getToken,
  getUser,
  setSession,
} from "./services/session";

App({
  globalData: {
    user: null as LotUser | null,
    loginError: "",
    debug: false,
    wechatLogin: false,
    managedRegistration: false,
    pendingRefs: [] as string[],
    posterJob: null as { id: string; topic: string } | null,
    /**
     * 当前在途的图片生成任务(studio 提交后写入)。
     * gallery 页 onShow 时读取并展示"生成中"封面。
     */
    activeImageJob: null as {
      conversationId: string;
      taskId: string;
      title: string;
      progress: number;
      statusText: string;
      imageUrl?: string;
    } | null,
  },
  ready: null as Promise<void> | null,

  onLaunch() {
    this.globalData.user = getUser();
    this.ready = this.bootstrap();
  },

  async bootstrap() {
    this.globalData.loginError = "";
    try {
      const mode = await api.mode();
      this.globalData.debug = mode.debug === true;
      this.globalData.wechatLogin = mode.wechatLogin === true;
      this.globalData.managedRegistration = mode.managedRegistration === true;
      if (mode.debug) {
        return;
      }
      if (getToken()) {
        try {
          const user = await api.me();
          setSession(getToken(), user);
          return;
        } catch {
          clearSession();
        }
      }
      // Only the boot page navigates after login. A cold launch from a shared
      // work must stay on that work, including for first-time visitors.
      await this.tryWechatLogin();
    } catch (err) {
      this.globalData.loginError = loginDiagnostic("mode", err);
      console.warn("[lot-login]", this.globalData.loginError);
    }
  },

  async ensureSession(): Promise<boolean> {
    if (this.ready) await this.ready.catch(() => {});
    if (this.globalData.debug) return true;
    if (getToken()) return true;
    const signedIn = await this.tryWechatLogin();
    if (signedIn) return true;
    this.sendToBoot();
    return false;
  },

  sendToBoot() {
    if (getCurrentPages().some((p) => p.route === "pages/boot/index")) return;
    wx.reLaunch({ url: "/pages/boot/index" });
  },

  async tryWechatLogin(): Promise<boolean> {
    this.globalData.loginError = "";
    const code = await new Promise<string>((resolve, reject) => {
      wx.login({
        success: (res) => (res.code ? resolve(res.code) : reject(new Error("no code"))),
        fail: (err) => reject(new Error(err.errMsg)),
      });
    }).catch((err) => {
      this.globalData.loginError = loginDiagnostic("wechat", err);
      console.warn("[lot-login]", this.globalData.loginError);
      return "";
    });
    if (!code) return false;
    try {
      const result = await api.wechatLogin(code);
      if (result.token && result.user) {
        setSession(result.token, result.user);
        return true;
      }
      this.globalData.loginError = "登录响应不完整，请稍后重试";
    } catch (err) {
      this.globalData.loginError = loginDiagnostic("server", err);
    }
    console.warn("[lot-login]", this.globalData.loginError);
    return false;
  },
});
