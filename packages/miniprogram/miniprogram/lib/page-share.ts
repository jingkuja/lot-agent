/** Ordinary pages share their entry, never account data, drafts or private asset URLs. */
export function pageShare(title: string, path: string) {
  // A bundled cover avoids WeChat's automatic screenshot of private page contents.
  const imageUrl = "/assets/share-cover.png";
  return {
    onReady() {
      wx.showShareMenu({ menus: ["shareAppMessage", "shareTimeline"] });
    },
    onShareAppMessage() {
      return { title, path, imageUrl };
    },
    onShareTimeline() {
      // Timeline always opens the current page; explicitly discard incoming queries.
      return { title, query: "", imageUrl };
    },
  };
}
