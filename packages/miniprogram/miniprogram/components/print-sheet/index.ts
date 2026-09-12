Component({
  properties: {
    src: { type: String, value: "" },
    busy: { type: Boolean, value: false },
    caption: { type: String, value: "" },
  },
  methods: {
    onPreview() {
      const src = this.data.src as string;
      if (!src) return;
      wx.previewImage({ urls: [src], current: src });
    },
  },
});
