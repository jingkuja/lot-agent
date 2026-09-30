import { listAttempts, refreshAttempt, removeAttempt, queueRetry } from "../../services/creation-attempts.js";
import { pageShare } from "../../lib/page-share.js";
import { absoluteMedia, api, type Conversation } from "../../services/api";

type GalleryItem = Conversation & { preview: string } & {
  attemptId?: string;
  failed?: boolean;
  generating?: boolean;
  progress?: number;
  statusText?: string;
};

const POLL_INTERVAL = 1200;

Page({
  ...pageShare("美图海报 · 管理你的图片与视频作品", "/pages/gallery/index"),
  data: {
    mediaType: "image",
    items: [] as GalleryItem[],
    nextCursor: null as string | null,
    loading: false,
    empty: false,
  },

  refreshing: false,
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

  selectType(e: { currentTarget: { dataset: { type: string } } }) {
    this.setData({ mediaType: e.currentTarget.dataset.type, items: [], nextCursor: null, empty: false });
    void this.reload();
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.tickAttempts();
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
    if (this.data.mediaType !== "image") return;
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
    if (this.data.mediaType !== "image") return items;
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

  mergeAttempts(items: GalleryItem[]): GalleryItem[] {
    const next = items.slice();
    for (const attempt of listAttempts().filter(item => item.mediaType === this.data.mediaType)) {
      const id = attempt.conversationId || attempt.id;
      const index = next.findIndex(item => item.id === id);
      if (index >= 0 && next[index].preview && !next[index].attemptId) {
        removeAttempt(attempt.id);
        continue;
      }
      const item: GalleryItem = {
        id, attemptId: attempt.id, title: attempt.title, agent_id: attempt.mediaType,
        updated_at: attempt.updatedAt, preview: attempt.preview || "",
        failed: attempt.status === "failed",
        generating: ["pending", "unknown", "submitting"].includes(attempt.status),
        statusText: attempt.status === "download_failed" ? "成品下载失败，请到网页版重试下载" : attempt.status === "pending" ? "正在生成" : "提交结果待确认",
      };
      if (index >= 0) next[index] = { ...next[index], ...item };
      else next.unshift(item);
    }
    return next.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },

  async tickAttempts() {
    if (this.refreshing) return;
    const attempts = listAttempts().filter(item => item.mediaType === this.data.mediaType && ["pending", "unknown", "submitting"].includes(item.status));
    if (!attempts.length) return;
    this.refreshing = true;
    try {
      await Promise.all(attempts.map(refreshAttempt));
      const items = this.mergeAttempts(this.data.items);
      this.setData({ items, empty: items.length === 0 });
    } finally { this.refreshing = false; }
  },

  async remove(e: { currentTarget: { dataset: { id: string } } }) {
    const item = this.data.items.find((entry: GalleryItem) => entry.id === e.currentTarget.dataset.id);
    if (!item?.failed || !item.attemptId) return;
    const owner = getApp().globalData.user?.id;
    const confirmed = await new Promise<boolean>(resolve => wx.showModal({
      title: "删除失败作品", content: "删除后将无法从作品列表恢复这次创作。", confirmText: "删除",
      success: ({ confirm }) => resolve(confirm), fail: () => resolve(false),
    }));
    if (!confirmed || owner !== getApp().globalData.user?.id) return;
    try {
      const attempt = listAttempts().find(entry => entry.id === item.attemptId);
      if (attempt?.conversationId) {
        try { await api.deleteConversation(attempt.conversationId); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
      if (owner !== getApp().globalData.user?.id) return;
      removeAttempt(item.attemptId);
      const items = this.data.items.filter((entry: GalleryItem) => entry.id !== item.id);
      this.setData({ items, empty: items.length === 0 });
    } catch { wx.showToast({ title: "删除失败，请稍后重试", icon: "none" }); }
  },

  async reload() {
    if (!(await getApp().ensureSession())) return;
    this.setData({ loading: true });
    try {
      const type = this.data.mediaType;
      const page = await api.listImageConversations(20, undefined, type);
      if (type !== this.data.mediaType) return;
      const activeJobId = getApp().globalData.activeImageJob?.conversationId ?? null;
      const items = page.items
        .map((item) => ({
          ...item,
          preview: absoluteMedia(item.preview_url),
        }))
        // 没有成品的本机提交记录由 mergeAttempts 合入，保留失败草稿及任务状态。
        .filter((item) => item.preview || item.id === activeJobId);
      const merged = this.mergeActiveJob(this.mergeAttempts(items));
      this.setData({
        items: merged,
        nextCursor: page.nextCursor,
        empty: merged.length === 0,
        loading: false,
      });
    } catch {
      const items = this.mergeAttempts(this.data.items);
      this.setData({ items, empty: items.length === 0, loading: false });
    }
    void this.tickAttempts();
  },

  async loadMore() {
    if (!this.data.nextCursor || this.data.loading) return;
    this.setData({ loading: true });
    try {
      const type = this.data.mediaType;
      const page = await api.listImageConversations(20, this.data.nextCursor, type);
      if (type !== this.data.mediaType) return;
      const activeJobId = getApp().globalData.activeImageJob?.conversationId ?? null;
      const extra = page.items
        .map((item) => ({ ...item, preview: absoluteMedia(item.preview_url) }))
        .filter((item) => item.preview || item.id === activeJobId);
      const items = [...new Map(this.data.items.concat(extra).map((item: GalleryItem) => [item.id, item] as const)).values()];
      const merged = this.mergeActiveJob(this.mergeAttempts(items));
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
    wx.switchTab({ url: this.data.mediaType === "video" ? "/pages/video/index" : "/pages/studio/index" });
  },

  async open(e: { currentTarget: { dataset: { id?: string; src: string; title: string; generating?: boolean } } }) {
    const { id, src, title, generating } = e.currentTarget.dataset;
    const item = this.data.items.find((entry: GalleryItem) => entry.id === id);
    if (item?.failed && item.attemptId) {
      const attempt = listAttempts().find(entry => entry.id === item.attemptId);
      if (!attempt) return;
      const owner = getApp().globalData.user?.id;
      await refreshAttempt(attempt);
      if (owner !== getApp().globalData.user?.id) return;
      if (attempt.status !== "failed") {
        await this.reload();
        wx.showToast({ title: "作品状态已更新，请查看", icon: "none" });
        return;
      }
      queueRetry(attempt);
      wx.switchTab({ url: attempt.mediaType === "video" ? "/pages/video/index" : "/pages/studio/index" });
      return;
    }
    if (generating) {
      wx.showToast({ title: "任务正在处理中，请稍后查看", icon: "none" });
      return;
    }
    if (!src) {
      wx.showToast({ title: item?.statusText || "作品还没生成好", icon: "none" });
      return;
    }
    let publication = this.data.items.find((item: GalleryItem) => item.id === id)?.metadata?.videoPublication;
    if (this.data.mediaType === "video") {
      // Older attempts only kept publication fields in the account's local draft.
      const saved = wx.getStorageSync(`lot:video:${getApp().globalData.user?.id || "debug"}`) as { conversationId?: unknown; draft?: { publishTitle?: unknown; mainTitle?: unknown; tags?: unknown } } | undefined;
      if (id && saved?.conversationId === id && saved.draft) {
        const draft = saved.draft;
        publication = { copy: typeof draft.publishTitle === "string" && draft.publishTitle ? draft.publishTitle : (typeof draft.mainTitle === "string" ? draft.mainTitle : ""), tags: typeof draft.tags === "string" ? draft.tags : "" };
        void api.saveVideoPublication(id, publication).catch(() => {});
      }
    }
    const displayTitle = publication ? [publication.copy, publication.tags].filter(Boolean).join(" ") : title || "";
    const extra = publication ? `&copy=${encodeURIComponent(publication.copy)}&tags=${encodeURIComponent(publication.tags)}` : "";
    wx.navigateTo({
      url: `/pages/preview/index?type=${this.data.mediaType}&src=${encodeURIComponent(src)}&title=${encodeURIComponent(displayTitle)}${extra}`,
    });
  },
});
