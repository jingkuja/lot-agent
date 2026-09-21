Page({
  data: { webUrl: "https://todoucloud.com", saving: false },
  copyWeb() { if (this.data.webUrl) wx.setClipboardData({ data: this.data.webUrl }); },

  async savePoster() {
    if (this.data.saving || !this.data.webUrl) return;
    this.setData({ saving: true });
    try {
      const ctx = wx.createCanvasContext("introPoster", this);
      ctx.setFillStyle("#faf7f4");
      ctx.fillRect(0, 0, 600, 760);
      ctx.setFillStyle("#c52b50");
      ctx.setFontSize(34);
      ctx.fillText("灵渠claw", 48, 88);
      ctx.setFillStyle("#29252b");
      ctx.setFontSize(38);
      ctx.fillText("从手机创作", 48, 162);
      ctx.fillText("到网页继续", 48, 216);
      ctx.setFontSize(24);
      ctx.fillText("AI 对话 · 图片与视频生成", 48, 296);
      ctx.fillText("文档 · PPT · 知识库资料引用", 48, 338);
      ctx.setFillStyle("#70656c");
      ctx.setFontSize(22);
      ctx.fillText("小程序修图、做海报，网页继续创作。", 48, 408);
      ctx.fillText("使用同一手机号登录，连接同一账户。", 48, 446);
      const link = (label: string, url: string, y: number) => {
        ctx.setFillStyle("#29252b");
        ctx.setFontSize(24);
        ctx.fillText(label, 48, y);
        ctx.setFillStyle("#c52b50");
        ctx.setFontSize(19);
        let line = "";
        let lineY = y + 40;
        for (const char of url) {
          if (ctx.measureText(line + char).width > 504) {
            ctx.fillText(line, 48, lineY);
            line = "";
            lineY += 28;
          }
          line += char;
        }
        ctx.fillText(line, 48, lineY);
      };
      link("灵渠claw 网页版", this.data.webUrl, 544);
      ctx.setFillStyle("#70656c");
      ctx.setFontSize(19);
      ctx.fillText("在小程序「我的 → 了解更多」复制网页地址", 48, 708);
      await new Promise<void>((resolve) => ctx.draw(false, resolve));
      const filePath = await new Promise<string>((resolve, reject) => wx.canvasToTempFilePath({
        canvasId: "introPoster", width: 600, height: 760, destWidth: 1200, destHeight: 1520,
        success: (res) => resolve(res.tempFilePath), fail: () => reject(new Error("海报生成失败")),
      }, this));
      await new Promise<void>((resolve, reject) => wx.saveImageToPhotosAlbum({
        filePath, success: resolve, fail: () => reject(new Error("保存失败，请检查相册权限")),
      }));
      wx.showToast({ title: "海报已保存", icon: "success" });
    } catch (err) {
      wx.showToast({ title: err instanceof Error ? err.message : "海报保存失败", icon: "none" });
      wx.getSetting({ success: ({ authSetting }) => {
        if (authSetting["scope.writePhotosAlbum"] === false) wx.showModal({
          title: "需要相册权限", content: "请在设置中允许保存到相册，然后再次保存海报。", confirmText: "去设置",
          success: ({ confirm }) => { if (confirm) wx.openSetting(); },
        });
      } });
    } finally { this.setData({ saving: false }); }
  },
});
