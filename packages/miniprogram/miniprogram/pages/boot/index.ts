import { DEFAULT_API_BASE } from "../../services/config";
import { getApiBase, getToken, setApiBase } from "../../services/session";

Page({
  data: {
    loading: true,
    error: "",
    apiBase: DEFAULT_API_BASE,
    showServer: false,
  },

  onLoad() {
    this.setData({ apiBase: getApiBase() });
  },

  async onShow() {
    await this.connect();
  },

  onField(e: { currentTarget: { dataset: { key: string } }; detail: { value: string } }) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
  },

  toggleServer() {
    this.setData({ showServer: !this.data.showServer });
  },

  saveServer() {
    const url = this.data.apiBase.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) {
      this.setData({ error: "服务器地址需要 http(s) 开头" });
      return;
    }
    setApiBase(url);
    this.setData({ showServer: false, error: "" });
    wx.showToast({ title: "已记住服务器", icon: "success" });
  },

  async retry() {
    await this.connect(true);
  },

  async connect(force = false) {
    this.setData({ loading: true, error: "" });
    const app = getApp();
    try {
      if (app.ready && !force) await app.ready;
      else await app.bootstrap();
      if (app.globalData.debug || getToken()) {
        wx.switchTab({ url: "/pages/studio/index" });
        return;
      }
      this.setData({ error: "微信登录失败，请检查服务器地址后重试", loading: false });
    } catch {
      this.setData({ error: "无法连接服务器，请检查地址后重试", loading: false });
    }
  },
});
