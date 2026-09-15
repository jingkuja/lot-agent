import { getToken } from "../../services/session";

Page({
  data: {
    loading: true,
    error: "",
  },

  async onShow() {
    await this.connect();
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
      this.setData({ error: "微信登录失败，请稍后重试", loading: false });
    } catch {
      this.setData({ error: "无法连接服务器，请稍后重试", loading: false });
    }
  },
});