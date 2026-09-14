import { absoluteMedia, api, type Conversation } from "../../services/api";

Page({
  data: {
    items: [] as Array<Conversation & { preview: string }>,
    nextCursor: null as string | null,
    loading: false,
    empty: false,
  },

  onShow() {
    void this.reload();
  },

  onPullDownRefresh() {
    void this.reload().finally(() => wx.stopPullDownRefresh());
  },

  async reload() {
    if (!(await getApp().ensureSession())) return;
    this.setData({ loading: true });
    try {
      const page = await api.listImageConversations(20);
      this.setData({
        items: page.items.map((item) => ({ ...item, preview: absoluteMedia(item.preview_url) })),
        nextCursor: page.nextCursor,
        empty: page.items.length === 0,
        loading: false,
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  async loadMore() {
    if (!this.data.nextCursor || this.data.loading) return;
    this.setData({ loading: true });
    try {
      const page = await api.listImageConversations(20, this.data.nextCursor);
      this.setData({
        items: this.data.items.concat(
          page.items.map((item) => ({ ...item, preview: absoluteMedia(item.preview_url) }))
        ),
        nextCursor: page.nextCursor,
        loading: false,
      });
    } catch {
      this.setData({ loading: false });
    }
  },

  goStudio() {
    wx.switchTab({ url: "/pages/studio/index" });
  },

  open(e: { currentTarget: { dataset: { src: string; title: string } } }) {
    const { src, title } = e.currentTarget.dataset;
    if (!src) {
      wx.showToast({ title: "这张还没生成好", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/preview/index?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title || "")}`,
    });
  },
});
