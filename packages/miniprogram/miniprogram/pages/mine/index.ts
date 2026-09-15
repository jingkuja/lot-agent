import { api } from "../../services/api";
import { getApiBase, getToken, getUser, setApiBase, setSession, clearSession } from "../../services/session";

Page({
  data: {
    user: null as LotUser | null,
    initial: "美",
    balanceText: "—",
    apiBase: "",
    editingServer: false,
    bindingPhone: false,
    editingName: false,
    nameDraft: "",
    savingName: false,
  },

  onShow() {
    this.setData({
      user: getUser(),
      initial: (getUser()?.name || getUser()?.username || "美").slice(0, 1),
      apiBase: getApiBase(),
    });
    void this.loadBalance();
  },

  async loadBalance() {
    if (!(await getApp().ensureSession())) return;
    try {
      const bal = await api.balance();
      const n = Number(bal.balance);
      this.setData({ balanceText: Number.isFinite(n) ? n.toFixed(2) : "—" });
    } catch {
      this.setData({ balanceText: "—" });
    }
  },

  goStudio() {
    wx.switchTab({ url: "/pages/studio/index" });
  },

  goPoster() {
    wx.switchTab({ url: "/pages/poster/index" });
  },

  goGallery() {
    wx.switchTab({ url: "/pages/gallery/index" });
  },

  startEditName() {
    if (!this.data.user || this.data.savingName) return;
    this.setData({
      editingName: true,
      nameDraft: this.data.user.name || this.data.user.username || "",
    });
  },

  onNameDraft(e: { detail: { value: string } }) {
    this.setData({ nameDraft: e.detail.value });
  },

  async saveName() {
    if (this.data.savingName) return;
    const displayName = this.data.nameDraft.trim();
    if (!displayName || [...displayName].length > 20) {
      wx.showToast({ title: "请输入 1 到 20 个字", icon: "none" });
      return;
    }
    if (!(await getApp().ensureSession())) return;
    this.setData({ savingName: true });
    try {
      const result = await api.updateProfile(displayName);
      setSession(getToken(), result.user);
      this.setData({
        user: result.user,
        initial: (result.user.name || result.user.username || "美").slice(0, 1),
        editingName: false,
      });
      wx.showToast({ title: "昵称已更新", icon: "success" });
    } catch (err) {
      wx.showToast({ title: err instanceof Error ? err.message : "修改失败", icon: "none" });
    } finally {
      this.setData({ savingName: false });
    }
  },

  toggleServer() {
    this.setData({ editingServer: !this.data.editingServer });
  },

  onServer(e: { detail: { value: string } }) {
    this.setData({ apiBase: e.detail.value });
  },

  saveServer() {
    const url = this.data.apiBase.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) {
      wx.showToast({ title: "需要 http(s) 地址", icon: "none" });
      return;
    }
    setApiBase(url);
    this.setData({ editingServer: false });
    wx.showToast({ title: "已保存", icon: "success" });
  },

  async onGetPhoneNumber(e: { detail: { code?: string; errMsg?: string } }) {
    if (this.data.bindingPhone) return;
    if (!e.detail.code) {
      wx.showToast({ title: e.detail.errMsg?.includes("deny") ? "需要授权手机号" : "未获取到手机号", icon: "none" });
      return;
    }
    if (!(await getApp().ensureSession())) return;
    this.setData({ bindingPhone: true });
    try {
      const result = await api.wechatPhoneBind(e.detail.code);
      if (result.token && result.user) {
        setSession(result.token, result.user);
      } else if (result.user) {
        setSession(getToken(), result.user);
      }
      this.setData({
        user: getUser(),
        initial: (getUser()?.name || getUser()?.username || "美").slice(0, 1),
      });
      wx.showToast({
        title: result.adopted ? "已切换到该手机号账号" : "手机号已绑定",
        icon: "success",
      });
      void this.loadBalance();
    } catch (err) {
      wx.showToast({ title: err instanceof Error ? err.message : "绑定失败", icon: "none" });
    } finally {
      this.setData({ bindingPhone: false });
    }
  },

  async logout() {
    try {
      await api.logout();
    } catch {
      // 本地仍会清理
    }
    clearSession();
    wx.reLaunch({ url: "/pages/boot/index" });
  },
});
