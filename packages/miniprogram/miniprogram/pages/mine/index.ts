import { api } from "../../services/api";
import { getApiBase, getUser, setApiBase, clearSession } from "../../services/session";

Page({
  data: {
    user: null as LotUser | null,
    initial: "印",
    balanceText: "—",
    apiBase: "",
    editingServer: false,
  },

  onShow() {
    this.setData({
      user: getUser(),
      initial: (getUser()?.name || getUser()?.username || "印").slice(0, 1),
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

  goEdit() {
    wx.navigateTo({ url: "/pages/edit/index" });
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

  async logout() {
    try {
      await api.logout();
    } catch {
      // local clear still happens
    }
    clearSession();
    wx.reLaunch({ url: "/pages/login/index" });
  },
});
