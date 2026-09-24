import { POSTER_CATS, POSTER_TEMPLATES } from "../../services/templates";

Page({
  data: {
    topic: "",
    cat: "all" as string,
    cats: POSTER_CATS,
    templates: POSTER_TEMPLATES,
    shown: POSTER_TEMPLATES,
  },

  goStudio() { wx.switchTab({ url: "/pages/studio/index" }); },

  onTopic(e: { detail: { value: string } }) {
    this.setData({ topic: e.detail.value });
  },

  pickCat(e: { currentTarget: { dataset: { key: string } } }) {
    const key = e.currentTarget.dataset.key;
    const shown =
      key === "all" ? POSTER_TEMPLATES : POSTER_TEMPLATES.filter((t) => t.cat === key);
    this.setData({ cat: key, shown });
  },

  useTemplate(e: { currentTarget: { dataset: { id: string } } }) {
    getApp().globalData.posterJob = {
      id: e.currentTarget.dataset.id,
      topic: this.data.topic.trim(),
    };
    wx.switchTab({ url: "/pages/studio/index" });
  },
});
