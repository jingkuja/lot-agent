import { absoluteMedia, api, type Conversation } from "../../services/api";

type GalleryItem = Conversation & { preview: string } & {
  generating?: boolean;
  progress?: number;
  statusText?: string;
};

const POLL_INTERVAL = 1200;

Page({
  data: {
    items: [] as GalleryItem[],
    nextCursor: null as string | null,
    loading: false,
    empty: false,
  },

  pollTimer: null as ReturnType<typeof setInterval> | null,

  onShow() {
    void this.reload();
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    void this.reload().finally(() => wx.stopPullDownRefresh());
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.tickActiveJob();
    }, POLL_INTERVAL);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  /** 跟随全局在途任务:更新进度;若已完成则从列表里移除占位并刷新 */
  async tickActiveJob() {
    const app = getApp();
    const job = app.globalData.activeImageJob;
    if (!job) return;
    try {
      const task = await api.getTask(job.taskId);
      if (task.status === "succeeded") {
        const url = task.output?.assets?.[0]?.url;
        if (url) {
          job.imageUrl = absoluteMedia(url);
          // 任务完成,清掉全局占位,重新拉一次列表展示真实封面
          app.globalData.activeImageJob = null;
          await this.reload();
        }
        return;
      }
      if (task.status === "failed" || task.status === "cancelled") {
        app.globalData.activeImageJob = null;
        await this.reload();
        return;
      }
      // 还在跑:若列表里这一项目前是占位,则刷新它的进度
      this.patchGeneratingItem(job.conversationId, job.progress, job.statusText);
    } catch {
      // 网络抖动就跳过这一轮,下轮再试
    }
  },

  /** 在 items 里找到生成中的占位并就地更新进度(避免整页 setData 闪动) */
  patchGeneratingItem(conversationId: string, progress?: number, statusText?: string) {
    const idx = this.data.items.findIndex((item: GalleryItem) => item.id === conversationId && item.generating);
    if (idx < 0) return;
    const patch: Record<string, unknown> = {};
    if (typeof progress === "number") patch[`items[${idx}].progress`] = progress;
    if (statusText) patch[`items[${idx}].statusText`] = statusText;
    if (Object.keys(patch).length) this.setData(patch as never);
  },

  /**
   * 把全局在途任务合成进服务端列表:
   * - 列表里已有该 conversation 且 preview 为空(正在生成的这条新会话) → 用 job 的进度数据增强它
   * - 列表里已有该 conversation 且有 preview(老会话,与本次生成无关) → 保持不动,避免遮住旧作品
   * - 列表里没有该 conversation(服务端 message 还没落库的窗口期) → 前插一个占位
   */
  mergeActiveJob(items: GalleryItem[]): GalleryItem[] {
    const app = getApp();
    const job = app.globalData.activeImageJob;
    if (!job) return items;
    const idx = items.findIndex((item) => item.id === job.conversationId);
    if (idx >= 0) {
      const existing = items[idx];
      if (existing.preview) return items;
      const next = items.slice();
      next[idx] = {
        ...existing,
        generating: true,
        progress: job.progress,
        statusText: job.statusText,
      };
      return next;
    }
    const placeholder: GalleryItem = {
      id: job.conversationId,
      title: job.title,
      agent_id: "image",
      updated_at: new Date().toISOString(),
      preview_url: null,
      preview: "",
      generating: true,
      progress: job.progress,
      statusText: job.statusText,
    };
    return [placeholder, ...items];
  },

  async reload() {
    if (!(await getApp().ensureSession())) return;
    this.setData({ loading: true });
    try {
      const page = await api.listImageConversations(20);
      const items = page.items.map((item) => ({
        ...item,
        preview: absoluteMedia(item.preview_url),
      }));
      const merged = this.mergeActiveJob(items);
      this.setData({
        items: merged,
        nextCursor: page.nextCursor,
        empty: merged.length === 0,
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
      const items = this.data.items.concat(
        page.items.map((item) => ({ ...item, preview: absoluteMedia(item.preview_url) }))
      );
      const merged = this.mergeActiveJob(items);
      this.setData({
        items: merged,
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

  open(e: { currentTarget: { dataset: { src: string; title: string; generating?: boolean } } }) {
    const { src, title, generating } = e.currentTarget.dataset;
    if (generating) {
      wx.showToast({ title: "这张还在生成中", icon: "none" });
      return;
    }
    if (!src) {
      wx.showToast({ title: "这张还没生成好", icon: "none" });
      return;
    }
    wx.navigateTo({
      url: `/pages/preview/index?src=${encodeURIComponent(src)}&title=${encodeURIComponent(title || "")}`,
    });
  },
});
