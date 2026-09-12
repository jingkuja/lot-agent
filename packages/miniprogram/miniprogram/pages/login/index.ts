import { api } from "../../services/api";
import { DEFAULT_API_BASE } from "../../services/config";
import {
  getApiBase,
  setApiBase,
  setSession,
} from "../../services/session";

Page({
  data: {
    method: "phone" as "phone" | "password",
    phone: "",
    code: "",
    username: "",
    password: "",
    countdown: 0,
    loading: false,
    error: "",
    apiBase: DEFAULT_API_BASE,
    showServer: false,
  },

  onLoad() {
    this.setData({ apiBase: getApiBase() });
  },

  usePhone() {
    this.setData({ method: "phone", error: "" });
  },

  usePassword() {
    this.setData({ method: "password", error: "" });
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

  async sendCode() {
    const phone = this.data.phone.trim();
    if (!/^1\d{10}$/.test(phone)) {
      this.setData({ error: "请输入中国大陆手机号" });
      return;
    }
    try {
      const result = await api.sendPhoneVerification(phone, "login");
      this.setData({ countdown: result.resendAfter || 60, error: "" });
      const timer = setInterval(() => {
        const next = this.data.countdown - 1;
        this.setData({ countdown: Math.max(0, next) });
        if (next <= 0) clearInterval(timer);
      }, 1000);
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : "验证码发送失败" });
    }
  },

  async submit() {
    this.setData({ loading: true, error: "" });
    try {
      const result =
        this.data.method === "phone"
          ? await api.phoneLogin(this.data.phone.trim(), this.data.code.trim())
          : await api.login(this.data.username.trim(), this.data.password);
      setSession(result.token, result.user);
      await getApp().bindPendingWechat();
      wx.switchTab({ url: "/pages/studio/index" });
    } catch (err) {
      this.setData({ error: err instanceof Error ? err.message : "登录失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
});
