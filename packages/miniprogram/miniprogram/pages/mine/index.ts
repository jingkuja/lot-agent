import { api } from "../../services/api";
import { getToken, getUser, setSession } from "../../services/session";
import { formatPoints, yuanToPoints } from "../../lib/points";

Page({
  data: {
    user: null as LotUser | null,
    initial: "美",
    balanceText: "—",
    fallbackState: "loading",
    bindingPhone: false,
    editingName: false,
    nameDraft: "",
    savingName: false,
  },

  onShow() {
    this.setData({
      user: getUser(),
      initial: (getUser()?.name || getUser()?.username || "美").slice(0, 1),
    });
    void this.loadBalance();
  },

  async loadBalance() {
    if (!(await getApp().ensureSession())) return;
    this.setData({ fallbackState: "loading", balanceText: "—" });
    const accountId = getUser()?.id;
    try {
      const bal = await api.balance();
      if (getUser()?.id !== accountId) return;
      // 接口返回元，按 1 元 = 100 积分换算展示
      this.setData({
        balanceText: formatPoints(yuanToPoints(Number(bal.balance))),
        fallbackState: typeof bal.allowBalanceFallback === "boolean" ? (bal.allowBalanceFallback ? "enabled" : "disabled") : "unavailable",
        user: getUser(),
      });
    } catch {
      if (getUser()?.id === accountId) this.setData({ balanceText: "—", fallbackState: "error" });
    }
  },

  goAbout() {
    wx.navigateTo({ url: "/pages/about/index" });
  },

  goStudio() {
    wx.switchTab({ url: "/pages/studio/index" });
  },

  goPoster() {
    wx.navigateTo({ url: "/pages/poster/index" });
  },

  goGallery() {
    wx.switchTab({ url: "/pages/gallery/index" });
  },

  goRecharge() {
    wx.navigateTo({ url: "/pages/recharge/index" });
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
      if (result.needConfirm && result.ticket && result.merge) {
        this.setData({ bindingPhone: false });
        const confirmed = await confirmPhoneMerge(result.merge);
        if (!confirmed) return;
        this.setData({ bindingPhone: true });
        const merged = await api.wechatPhoneMerge(result.ticket);
        this.applyBoundUser(merged.token, merged.user);
        wx.showToast({ title: "已合并到该手机号账号", icon: "success" });
        void this.loadBalance();
        return;
      }
      this.applyBoundUser(result.token, result.user);
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

  applyBoundUser(token: string | undefined, user: LotUser | undefined) {
    const previousId = getUser()?.id;
    if (token && user) setSession(token, user);
    else if (user) setSession(getToken(), user);
    this.setData({
      user: getUser(),
      initial: (getUser()?.name || getUser()?.username || "美").slice(0, 1),
    });
    // Clear cached tab pages too: they may still contain the previous account's
    // gallery, rendered images and form drafts even after global data is reset.
    if (previousId !== getUser()?.id) wx.reLaunch({ url: "/pages/mine/index" });
  },
});

function formatAmount(value: number): string {
  // 接口返回元，统一按 1 元 = 100 积分展示
  return formatPoints(yuanToPoints(value));
}

function confirmPhoneMerge(merge: {
  targetName: string;
  quotaAmount: number;
  managedRemainAmount: number;
  conversations: number;
  assets: number;
  tasks: number;
}): Promise<boolean> {
  const lines = [
    `该手机号已是账号「${merge.targetName || "已有用户"}」。`,
    "确认后将转入：",
    `· 托管积分 ${formatAmount(merge.managedRemainAmount)}`,
    `· 账户积分 ${formatAmount(merge.quotaAmount)}`,
    `· 对话 ${merge.conversations} 条`,
    `· 作品 ${merge.assets} 个`,
    "当前小程序账号将注销。",
  ];
  return new Promise((resolve) => {
    wx.showModal({
      title: "合并到已有账号",
      content: lines.join("\n"),
      confirmText: "确认合并",
      cancelText: "取消",
      success: (res) => resolve(res.confirm === true),
    });
  });
}
