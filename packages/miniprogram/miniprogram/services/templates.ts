export interface PosterTemplate {
  id: string;
  title: string;
  blurb: string;
  size: string;
  ratio: string;
  tone: "pink" | "peach" | "lavender" | "mint" | "sky" | "gold" | "night";
  coverTitle: string;
  coverCaption: string;
  cat: "store" | "ecom" | "social";
  prompt: string;
}

export const POSTER_TEMPLATES: PosterTemplate[] = [
  {
    id: "moments-sale",
    title: "朋友圈促销",
    blurb: "竖版,价格一眼看见",
    size: "1024x1536",
    ratio: "2:3",
    tone: "pink",
    coverTitle: "好物\n好价",
    coverCaption: "小店好消息",
    cat: "store",
    prompt:
      "一张中文营销海报,竖构图。主题:{{topic}}。上三分之一大标题,中间产品或场景主视觉,底部活动时间和一句行动号召。印刷海报质感,干净排版,不要英文乱码,不要水印。",
  },
  {
    id: "grand-open",
    title: "门店开业",
    blurb: "灯笼、剪彩、到店礼",
    size: "1024x1536",
    ratio: "2:3",
    tone: "gold",
    coverTitle: "开门\n见喜",
    coverCaption: "新店开业",
    cat: "store",
    prompt:
      "中式开业海报,主题:{{topic}}。红金配色但克制,主标题「开业志禧」,辅以门店外观或室内氛围,留出地址和开业日期位置。喜庆、专业,像印刷厂打样。",
  },
  {
    id: "food-set",
    title: "餐饮套餐",
    blurb: "食欲向,适合堂食/外卖",
    size: "1024x1536",
    ratio: "2:3",
    tone: "peach",
    coverTitle: "好好\n吃饭",
    coverCaption: "今日推荐",
    cat: "store",
    prompt:
      "美食海报,竖构图。主题:{{topic}}。食物特写,蒸汽与高光,菜单式中文标题,价格用大号数字,背景深色让食物跳出来,食欲感强。",
  },
  {
    id: "hiring",
    title: "招聘启事",
    blurb: "岗位墙,适合转发",
    size: "1024x1536",
    ratio: "2:3",
    tone: "night",
    coverTitle: "一起\n做点事",
    coverCaption: "伙伴招募",
    cat: "store",
    prompt:
      "招聘海报。主题:{{topic}}。深色背景,粉色强调色,大标题「我们在找你」,中部岗位要点三条,底部投递方式位置。现代、克制、可直接发朋友圈。",
  },
  {
    id: "new-product",
    title: "新品上市",
    blurb: "静物主图,适合电商",
    size: "1024x1024",
    ratio: "1:1",
    tone: "sky",
    coverTitle: "新鲜\n登场",
    coverCaption: "发现新好物",
    cat: "ecom",
    prompt:
      "电商主图海报,正方形。主题:{{topic}}。产品居中,柔和影棚光,浅色无缝背景,左上角小标签「NEW」,中文品牌感排版,高级而不廉价。",
  },
  {
    id: "beauty",
    title: "美妆种草",
    blurb: "质感肤感,适合种草",
    size: "1024x1536",
    ratio: "2:3",
    tone: "lavender",
    coverTitle: "美好\n日常",
    coverCaption: "给自己一点宠爱",
    cat: "ecom",
    prompt:
      "美妆营销海报。主题:{{topic}}。干净化妆台与自然光,产品特写,柔雾皮肤质感,中文短标题,杂志内页排版,不要夸张滤镜脸。",
  },
  {
    id: "edu",
    title: "课程招生",
    blurb: "信任感,适合教培",
    size: "1024x1536",
    ratio: "2:3",
    tone: "mint",
    coverTitle: "学点\n新东西",
    coverCaption: "把好奇心留下",
    cat: "ecom",
    prompt:
      "教育培训招生海报。主题:{{topic}}。理性配色,清晰中文层级:主标题、适合人群、开课时间。插画或教室场景,专业可信,不要卡通乱。",
  },
  {
    id: "festival",
    title: "节日祝福",
    blurb: "节气/节日品牌问候",
    size: "1024x1024",
    ratio: "1:1",
    tone: "peach",
    coverTitle: "把祝福\n送给你",
    coverCaption: "日子里的小心意",
    cat: "social",
    prompt:
      "品牌节日祝福海报,正方形。主题:{{topic}}。中国节气美学,留白与一枚主视觉(花、月、灯),中文祝福短句,像一张可装裱的贺卡。",
  },
  {
    id: "live",
    title: "直播预告",
    blurb: "横版封面,适合视频号",
    size: "1536x1024",
    ratio: "3:2",
    tone: "night",
    coverTitle: "今晚\n见一面",
    coverCaption: "直播预告",
    cat: "social",
    prompt:
      "直播预告封面,横构图。主题:{{topic}}。主播或产品在右侧,左侧大号中文开播时间,底部平台名位置。舞台灯光,能量感,不要文字堆砌。",
  },
  {
    id: "wide-banner",
    title: "活动横幅",
    blurb: "16:9 推文头图",
    size: "1920x1088",
    ratio: "16:9",
    tone: "sky",
    coverTitle: "好事\n即将发生",
    coverCaption: "下一场相遇",
    cat: "social",
    prompt:
      "活动横幅,16:9。主题:{{topic}}。左对齐中文主标题,背景是与主题相关的场景虚化,右侧留空。适合做公众号头图。",
  },
];

export const POSTER_CATS = [
  { key: "all", label: "全部" },
  { key: "store", label: "门店经营" },
  { key: "ecom", label: "电商种草" },
  { key: "social", label: "社交宣传" },
] as const;

export function fillTemplate(prompt: string, topic: string): string {
  return prompt.replace(/\{\{topic\}\}/g, topic.trim() || "品牌活动");
}
