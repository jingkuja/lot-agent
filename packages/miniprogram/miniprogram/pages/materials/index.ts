import { pageShare } from "../../lib/page-share.js";
import { absoluteMedia, api, type UploadedAsset } from "../../services/api";
import { getUser } from "../../services/session";

type ItemEvent = { currentTarget: { dataset: { id: string } } };

Page({
  ...pageShare("美图海报 · 管理创作素材", "/pages/materials/index"),
  data: { items: [] as UploadedAsset[], loading: true, error: "", deletingId: "" },
  requestId: 0,
  owner: "",
  unloaded: false,
  onShow() { void this.reload(); },
  onUnload() { this.unloaded = true; this.requestId++; },
  onPullDownRefresh() { void this.reload().finally(() => wx.stopPullDownRefresh()); },

  async reload() {
    if (this.data.deletingId) return;
    const requestId = ++this.requestId;
    if (!(await getApp().ensureSession()) || this.unloaded || requestId !== this.requestId) return;
    const owner = getUser()?.id || "";
    if (owner !== this.owner) this.setData({ items: [] });
    this.owner = owner;
    this.setData({ loading: true, error: "" });
    try {
      const result = await api.listUploads();
      if (this.unloaded || requestId !== this.requestId || owner !== getUser()?.id) return;
      this.setData({ items: result.data.filter(item => item.mime.startsWith("image/")).map(item => ({ ...item, url: absoluteMedia(item.url) })) });
    } catch {
      if (!this.unloaded && requestId === this.requestId && owner === getUser()?.id) this.setData({ error: "素材加载失败，请重试" });
    } finally {
      if (!this.unloaded && requestId === this.requestId) this.setData({ loading: false });
    }
  },

  preview(e: ItemEvent) {
    if (this.owner !== getUser()?.id) return;
    const item = this.data.items.find((item: UploadedAsset) => item.id === e.currentTarget.dataset.id);
    if (item) wx.previewImage({ current: item.url, urls: this.data.items.map((item: UploadedAsset) => item.url) });
  },

  async remove(e: ItemEvent) {
    if (this.data.loading || this.data.deletingId || this.owner !== getUser()?.id) return;
    const id = e.currentTarget.dataset.id;
    if (!this.data.items.some((item: UploadedAsset) => item.id === id)) return;
    const owner = this.owner;
    this.setData({ deletingId: id });
    try {
      const confirmed = await new Promise<boolean>(resolve => wx.showModal({
        title: "删除素材", content: "删除后无法恢复，使用这张图片的历史引用也可能无法查看。确定删除吗？", confirmText: "删除", cancelText: "保留",
        success: result => resolve(result.confirm === true), fail: () => resolve(false),
      }));
      if (!confirmed || this.unloaded || owner !== getUser()?.id) return;
      await api.deleteUpload(id);
      if (this.unloaded || owner !== getUser()?.id) return;
      this.setData({ items: this.data.items.filter((item: UploadedAsset) => item.id !== id) });
      wx.showToast({ title: "已删除", icon: "success" });
    } catch {
      if (!this.unloaded && owner === getUser()?.id) wx.showToast({ title: "删除失败，请重试", icon: "none" });
    } finally {
      if (!this.unloaded) this.setData({ deletingId: "" });
    }
  },
});
