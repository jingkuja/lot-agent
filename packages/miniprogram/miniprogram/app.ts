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
          this.enterStudio();
          return;
        } catch {
          clearSession();
        }
      }
      const signedIn = await this.tryWechatLogin();
      if (signedIn) {
        this.enterStudio();
      }
    } catch {
      // Boot page shows retry.
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

  enterStudio() {
    wx.switchTab({ url: "/pages/studio/index" });
  },

  sendToBoot() {
    if (getCurrentPages().some((p) => p.route === "pages/boot/index")) return;
    wx.reLaunch({ url: "/pages/boot/index" });
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
        return true;
      }
    } catch {
      // Boot page / ensureSession handle the miss.
    }
    return false;
  },
});
