// Transcribed from the user-supplied workbook. Content is policy data, never executable instructions.
// B14 uses Excel percentage format: its stored numeric value 1 means 100%, not the word "1".
export const MARKETING_RISK_TABLE = {
  "source": {
    "title": "黑名单风险词规则表.xlsx",
    "sheet": "Sheet1",
    "importedAt": "2026-10-15"
  },
  "blacklist": [
    "传销",
    "博彩",
    "赌博",
    "毒品",
    "刷单",
    "非法套现",
    "资金盘",
    "杀猪盘",
    "色情",
    "嫖娼",
    "高利贷",
    "裸贷",
    "走私",
    "洗钱"
  ],
  "conditionalRules": [
    {
      "id": "risk-table-1",
      "terms": [
        "躺赚"
      ],
      "triggers": [
        "副业",
        "项目",
        "赚钱",
        "收益"
      ],
      "reason": "搭配赚钱类词，宣传不劳而获，极易违规引流；单独用在段子、表情包描述不违规",
      "suggestedWording": "轻松增收、省心变现"
    },
    {
      "id": "risk-table-2",
      "terms": [
        "必赚"
      ],
      "triggers": [
        "副业",
        "项目",
        "投资",
        "创业"
      ],
      "reason": "打包票保证一定赚到钱，承诺收益，平台判定违规",
      "suggestedWording": "有机会增收、提升收益"
    },
    {
      "id": "risk-table-3",
      "terms": [
        "稳赚"
      ],
      "triggers": [
        "副业",
        "项目",
        "投资",
        "赛道"
      ],
      "reason": "承诺保本、收益稳定不亏损",
      "suggestedWording": "收益可观、收益稳定可期"
    },
    {
      "id": "risk-table-4",
      "terms": [
        "100%"
      ],
      "triggers": [
        "见效",
        "治愈",
        "赚钱",
        "成功"
      ],
      "reason": "百分百承诺效果或者收益，属于极限夸大",
      "suggestedWording": "大概率、很大程度"
    },
    {
      "id": "risk-table-5",
      "terms": [
        "根治"
      ],
      "triggers": [
        "产品",
        "方法",
        "配方",
        "调理"
      ],
      "reason": "宣称可以彻底治好病症，医疗类违规",
      "suggestedWording": "改善、缓解、辅助调理"
    },
    {
      "id": "risk-table-6",
      "terms": [
        "特效"
      ],
      "triggers": [
        "治病",
        "病痛",
        "炎症",
        "症状"
      ],
      "reason": "宣传产品有医疗疗效；如果是视频剪辑特效则不算违规",
      "suggestedWording": "出众效果、画面特效"
    },
    {
      "id": "risk-table-7",
      "terms": [
        "第一"
      ],
      "triggers": [
        "产品",
        "效果",
        "功效",
        "行业"
      ],
      "reason": "夸大排名，绝对化宣传；引用第三方榜单数据除外",
      "suggestedWording": "头部、行业热门"
    },
    {
      "id": "risk-table-8",
      "terms": [
        "最强"
      ],
      "triggers": [
        "功效",
        "效果",
        "产品",
        "收益"
      ],
      "reason": "夸大产品 / 收益能力；描述硬件性能参数不算违规",
      "suggestedWording": "性能优秀、竞争力强"
    },
    {
      "id": "risk-table-9",
      "terms": [
        "最高"
      ],
      "triggers": [
        "收益",
        "疗效",
        "效果"
      ],
      "reason": "夸大效果、收益上限",
      "suggestedWording": "较高、可观"
    },
    {
      "id": "risk-table-10",
      "terms": [
        "永不"
      ],
      "triggers": [
        "失效",
        "反弹",
        "亏本"
      ],
      "reason": "承诺永久不会出现负面情况",
      "suggestedWording": "不容易、大幅降低"
    },
    {
      "id": "risk-table-11",
      "terms": [
        "国家级"
      ],
      "triggers": [
        "产品",
        "技术",
        "项目"
      ],
      "reason": "随便用国家级背书，虚假宣传；官方授予资质除外",
      "suggestedWording": "行业级、高标准"
    },
    {
      "id": "risk-table-12",
      "terms": [
        "永不复发"
      ],
      "triggers": [
        "调理",
        "治疗",
        "皮肤问题"
      ],
      "reason": "承诺病症永远不会复发",
      "suggestedWording": "降低复发概率"
    },
    {
      "id": "risk-table-14",
      "terms": [
        "降三高"
      ],
      "triggers": [
        "茶",
        "食品",
        "膏方",
        "保健品"
      ],
      "reason": "普通食品宣称降血压 / 血糖 / 血脂，严重违规",
      "suggestedWording": "日常养护、辅助调理身体"
    },
    {
      "id": "risk-table-15",
      "terms": [
        "排毒"
      ],
      "triggers": [
        "饮品",
        "食品",
        "护肤品",
        "药膏"
      ],
      "reason": "宣称产品可以给身体排毒",
      "suggestedWording": "帮助代谢、舒缓调理"
    },
    {
      "id": "risk-table-16",
      "terms": [
        "消炎"
      ],
      "triggers": [
        "护肤品",
        "面膜",
        "精油",
        "膏剂"
      ],
      "reason": "普通美妆 / 日用品宣称消炎杀菌，属于医疗功效",
      "suggestedWording": "舒缓泛红、维稳肌肤"
    },
    {
      "id": "risk-table-17",
      "terms": [
        "防癌",
        "抗癌"
      ],
      "triggers": [
        "食品",
        "饮品",
        "保健品"
      ],
      "reason": "普通产品宣称抗癌防癌",
      "suggestedWording": "日常膳食养护"
    },
    {
      "id": "risk-table-18",
      "terms": [
        "助眠"
      ],
      "triggers": [
        "食品",
        "香薰",
        "饮品"
      ],
      "reason": "普通食品不能宣称治疗失眠",
      "suggestedWording": "舒缓情绪、更容易入睡"
    },
    {
      "id": "risk-table-19",
      "terms": [
        "祛斑"
      ],
      "triggers": [
        "面膜",
        "精华",
        "面霜"
      ],
      "reason": "普通化妆品宣称祛斑（特证除外）",
      "suggestedWording": "提亮肤色、淡化暗沉"
    },
    {
      "id": "risk-table-20",
      "terms": [
        "祛痘"
      ],
      "triggers": [
        "护肤品",
        "精华"
      ],
      "reason": "普通产品宣称根治痘痘，医疗功效违规",
      "suggestedWording": "舒缓痘痘、改善肤质"
    },
    {
      "id": "risk-table-21",
      "terms": [
        "生发"
      ],
      "triggers": [
        "洗发水",
        "育发液（无特证）"
      ],
      "reason": "无特证产品承诺生发",
      "suggestedWording": "滋养发根、养护头皮"
    },
    {
      "id": "risk-table-22",
      "terms": [
        "无副作用"
      ],
      "triggers": [
        "产品",
        "配方",
        "调理"
      ],
      "reason": "宣称产品完全没有副作用",
      "suggestedWording": "相对温和、降低刺激"
    },
    {
      "id": "risk-table-23",
      "terms": [
        "祖传秘方"
      ],
      "triggers": [
        "治病",
        "药膏",
        "偏方"
      ],
      "reason": "医疗场景用偏方宣传；普通食品配方不受限",
      "suggestedWording": "传统配方、古法配方"
    },
    {
      "id": "risk-table-25",
      "terms": [
        "保本"
      ],
      "triggers": [
        "理财",
        "项目",
        "投资"
      ],
      "reason": "承诺本金不会亏损",
      "suggestedWording": "风险较低、相对稳健"
    },
    {
      "id": "risk-table-26",
      "terms": [
        "零风险"
      ],
      "triggers": [
        "赚钱",
        "投资",
        "副业",
        "项目"
      ],
      "reason": "宣称这件事完全没有风险",
      "suggestedWording": "风险可控、风险较低"
    },
    {
      "id": "risk-table-27",
      "terms": [
        "月入过万"
      ],
      "triggers": [
        "副业",
        "兼职",
        "项目"
      ],
      "reason": "夸大副业收入，制造暴富假象",
      "suggestedWording": "增加副业收入、提升额外收益"
    },
    {
      "id": "risk-table-28",
      "terms": [
        "兜底"
      ],
      "triggers": [
        "投资",
        "项目",
        "带货"
      ],
      "reason": "承诺亏损兜底、包回本",
      "suggestedWording": "尽量降低损失、做好风控"
    },
    {
      "id": "risk-table-30",
      "terms": [
        "医生推荐"
      ],
      "triggers": [
        "产品",
        "药膏",
        "保健品"
      ],
      "reason": "无真实合作，假借医生 / 三甲医院背书",
      "suggestedWording": "很多用户反馈、专业人士分享"
    },
    {
      "id": "risk-table-31",
      "terms": [
        "专利配方"
      ],
      "triggers": [
        "产品",
        "护肤品",
        "食品"
      ],
      "reason": "没有专利号，口头宣称专利配方",
      "suggestedWording": "自研配方、特色配方"
    },
    {
      "id": "risk-table-32",
      "terms": [
        "纯天然"
      ],
      "triggers": [
        "护肤品",
        "食品"
      ],
      "reason": "绝对化宣称零添加，容易判定虚假宣传",
      "suggestedWording": "天然原料为主、原料纯净"
    },
    {
      "id": "risk-table-33",
      "terms": [
        "免检产品"
      ],
      "triggers": [
        "产品",
        "好物"
      ],
      "reason": "宣称国家免检，广告法禁用",
      "suggestedWording": "经过质检、符合行业标准"
    },
    {
      "id": "risk-table-35",
      "terms": [
        "无效退款"
      ],
      "triggers": [
        "护肤品",
        "产品",
        "课程"
      ],
      "reason": "打包票没效果就退款，属于效果承诺",
      "suggestedWording": "不满意可按售后规则处理"
    },
    {
      "id": "risk-table-36",
      "terms": [
        "仅此一次"
      ],
      "triggers": [
        "活动",
        "福利",
        "优惠"
      ],
      "reason": "制造虚假稀缺感",
      "suggestedWording": "限时福利、本期活动专享"
    },
    {
      "id": "risk-table-37",
      "terms": [
        "最后一波"
      ],
      "triggers": [
        "库存",
        "活动",
        "特价"
      ],
      "reason": "虚假紧迫感营销",
      "suggestedWording": "本期特惠、限时放送"
    },
    {
      "id": "risk-table-38",
      "terms": [
        "手慢无"
      ],
      "triggers": [
        "商品",
        "福利"
      ],
      "reason": "强诱导下单",
      "suggestedWording": "库存有限，喜欢尽早入手"
    },
    {
      "id": "risk-table-39",
      "terms": [
        "秒杀"
      ],
      "triggers": [
        "疾病",
        "病痛",
        "顽固问题"
      ],
      "reason": "宣称一次性解决病痛；描述商品抢购秒杀不算违规",
      "suggestedWording": "快速改善、有效处理"
    },
    {
      "id": "risk-table-41",
      "terms": [
        "一比一"
      ],
      "triggers": [
        "包包",
        "手表",
        "首饰"
      ],
      "reason": "暗示高仿复刻、仿品",
      "suggestedWording": "同款风格、相似设计"
    },
    {
      "id": "risk-table-42",
      "terms": [
        "原单"
      ],
      "triggers": [
        "服饰",
        "奢侈品"
      ],
      "reason": "暗示原厂尾单假货",
      "suggestedWording": "同风格款式、平替款"
    }
  ],
  "exceptions": [
    {
      "id": "exception-1",
      "combination": "最强，服务器跑分",
      "context": "描述硬件性能参数，不属于广告夸大宣传"
    },
    {
      "id": "exception-2",
      "combination": "特效，视频、剪辑、影视、画面",
      "context": "指视频画面特效、影视特效，不是医疗功效描述"
    },
    {
      "id": "exception-3",
      "combination": "第一，季度销量榜单、年度榜单、第三方榜单",
      "context": "引用权威第三方公开榜单数据，客观陈述，不算违规夸大"
    },
    {
      "id": "exception-4",
      "combination": "专利配方，附带真实专利号",
      "context": "文案同时标注真实专利编号，属于合规陈述"
    },
    {
      "id": "exception-5",
      "combination": "祛斑，化妆品 + 国妆特证编号",
      "context": "产品具备正规国妆祛斑特证，可合规宣传祛斑功效"
    },
    {
      "id": "exception-6",
      "combination": "纯天然，原材料检测报告",
      "context": "引用检测报告说明原料天然，不是绝对化零添加承诺"
    },
    {
      "id": "exception-7",
      "combination": "国家级，官方颁发证书、国家级赛事奖项",
      "context": "拥有国家机构颁发的证书、奖项，属实可正常描述"
    },
    {
      "id": "exception-8",
      "combination": "100%，纯棉、羊毛、蚕丝等材质成分标注",
      "context": "产品成分标签真实标注材质占比，属于客观材质说明，不是效果承诺"
    },
    {
      "id": "exception-9",
      "combination": "消炎，医用产品 + 医疗器械备案号",
      "context": "具备医疗器械备案，合规描述产品消炎作用，普通护肤品不适用"
    },
    {
      "id": "exception-10",
      "combination": "秒杀，直播间商品、抢购活动",
      "context": "直播间讲商品限时秒杀，不是用来描述治疗疾病"
    },
    {
      "id": "exception-11",
      "combination": "最高，温度、海拔、测试数据、参数",
      "context": "描述客观物理参数、实验数据，不用于产品功效和收益宣传"
    },
    {
      "id": "exception-12",
      "combination": "永不，金属材质防锈、面料耐洗",
      "context": "描述工业、面料物理属性，不用于效果、收益承诺"
    },
    {
      "id": "exception-13",
      "combination": "生发，育发产品持有国妆特证",
      "context": "拥有正规育发特证，可合规宣传育发相关描述"
    },
    {
      "id": "exception-14",
      "combination": "医生推荐，有正规合作协议 + 资质公示",
      "context": "品牌和医师存在真实合作，资质对外公示，不是假借名义宣传"
    }
  ]
} as const;
