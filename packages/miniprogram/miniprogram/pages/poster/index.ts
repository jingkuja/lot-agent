import { POSTER_TEMPLATES } from "../../services/templates";

Page({
  data: {
    topic: "",
    templates: POSTER_TEMPLATES,
  },

  onTopic(e: { detail: { value: string } }) {
    this.setData({ topic: e.detail.value });
  },

  useTemplate(e: { currentTarget: { dataset: { id: string } } }) {
    getApp().globalData.posterJob = {
      id: e.currentTarget.dataset.id,
      topic: this.data.topic.trim(),
    };
    wx.switchTab({ url: "/pages/studio/index" });
  },
});
