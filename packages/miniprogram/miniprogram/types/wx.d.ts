declare function App<T>(options: T & ThisType<any>): void;
declare function Page<T>(options: T & ThisType<any>): void;
declare function Component<T>(options: T & ThisType<any>): void;
declare function getApp<T = LotApp>(): T;
declare function getCurrentPages(): Array<{ route: string }>;

interface LotUser {
  id: string;
  name: string;
  username: string | null;
  phone: string | null;
}

interface LotApp {
  globalData: {
    user: LotUser | null;
    debug: boolean;
    wechatLogin: boolean;
    managedRegistration: boolean;
    pendingRefs: string[];
    posterJob: { id: string; topic: string } | null;
    activeImageJob: {
      conversationId: string;
      taskId: string;
      title: string;
      progress: number;
      statusText: string;
      imageUrl?: string;
    } | null;
  };
  ready: Promise<void> | null;
  bootstrap(): Promise<void>;
  ensureSession(): Promise<boolean>;
  tryWechatLogin(): Promise<boolean>;
}

interface WxRequestSuccess {
  statusCode: number;
  data: unknown;
  header?: Record<string, string>;
}

interface WxGeneralCallbackResult {
  errMsg: string;
}

interface WxGetRandomValuesSuccess {
  randomValues: ArrayBuffer;
}

declare const wx: {
  hideShareMenu(opts: { menus: string[] }): void;
  showShareMenu(opts: { menus: string[] }): void;
  createCanvasContext(canvasId: string, component?: unknown): {
    setFillStyle(color: string): void;
    setFontSize(size: number): void;
    fillRect(x: number, y: number, width: number, height: number): void;
    fillText(text: string, x: number, y: number): void;
    measureText(text: string): { width: number };
    draw(reserve: boolean, callback: () => void): void;
  };
  canvasToTempFilePath(opts: {
    canvasId: string; width: number; height: number; destWidth: number; destHeight: number;
    success: (res: { tempFilePath: string }) => void;
    fail: (err: WxGeneralCallbackResult) => void;
  }, component?: unknown): void;
  request(opts: {
    url: string;
    method?: string;
    data?: unknown;
    header?: Record<string, string>;
    timeout?: number;
    success?: (res: WxRequestSuccess) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  uploadFile(opts: {
    url: string;
    filePath: string;
    name: string;
    header?: Record<string, string>;
    formData?: Record<string, string>;
    success?: (res: { statusCode: number; data: string }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  requestPayment(opts: {
    timeStamp: string;
    nonceStr: string;
    package: string;
    signType?: "MD5" | "HMAC-SHA256" | "RSA";
    paySign: string;
    success?: (res: WxGeneralCallbackResult) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  downloadFile(opts: {
    url: string;
    header?: Record<string, string>;
    success?: (res: { statusCode: number; tempFilePath: string }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, data: unknown): void;
  removeStorageSync(key: string): void;
  login(opts: {
    success?: (res: { code: string }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  getPhoneNumber?: (opts: {
    success?: (res: { code?: string; errMsg: string }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }) => void;
  getRandomValues?(opts: {
    length: number;
    success?: (res: WxGetRandomValuesSuccess) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  chooseMedia(opts: {
    count?: number;
    mediaType?: Array<"image" | "video">;
    sourceType?: Array<"album" | "camera">;
    success?: (res: { tempFiles: Array<{ tempFilePath: string; size: number; fileType: string }> }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  previewImage(opts: { urls: string[]; current?: string }): void;
  saveImageToPhotosAlbum(opts: {
    filePath: string;
    success?: () => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  authorize(opts: {
    scope: string;
    success?: () => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  getSetting(opts: {
    success?: (res: { authSetting: Record<string, boolean> }) => void;
    fail?: (err: WxGeneralCallbackResult) => void;
  }): void;
  openSetting(opts?: {
    success?: (res: { authSetting: Record<string, boolean> }) => void;
  }): void;
  showToast(opts: { title: string; icon?: "success" | "error" | "loading" | "none"; duration?: number }): void;
  showModal(opts: {
    title?: string;
    content: string;
    showCancel?: boolean;
    confirmText?: string;
    cancelText?: string;
    success?: (res: { confirm: boolean; cancel: boolean }) => void;
  }): void;
  showLoading(opts: { title: string; mask?: boolean }): void;
  hideLoading(): void;
  showActionSheet(opts: {
    itemList: string[];
    success?: (res: { tapIndex: number }) => void;
  }): void;
  setNavigationBarTitle(opts: { title: string }): void;
  setClipboardData(opts: { data: string; success?: () => void }): void;
  navigateTo(opts: { url: string }): void;
  redirectTo(opts: { url: string }): void;
  reLaunch(opts: { url: string }): void;
  switchTab(opts: { url: string }): void;
  navigateBack(opts?: { delta?: number }): void;
  showShareImageMenu?(opts: { path: string }): void;
  stopPullDownRefresh(): void;
};
