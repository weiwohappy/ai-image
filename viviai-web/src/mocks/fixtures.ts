import type {
  BatchTask,
  GenerationTask,
  ImageAsset,
  Inspiration,
  InviteRelation,
  ModelConfig,
  NotificationItem,
  Order,
  Plan,
  PointLedgerEntry,
  ToolTemplate,
  User,
  ViralTemplate,
  Workflow,
} from '@/src/types/domain';

export interface MockDatabase {
  sessionUserId: string | null;
  user: User;
  credentialHash: string;
  models: ModelConfig[];
  tasks: GenerationTask[];
  assets: ImageAsset[];
  deletedAssets: ImageAsset[];
  inspirations: Inspiration[];
  templates: ViralTemplate[];
  tools: ToolTemplate[];
  workflows: Workflow[];
  batches: BatchTask[];
  plans: Plan[];
  orders: Order[];
  ledger: PointLedgerEntry[];
  notifications: NotificationItem[];
  invites: InviteRelation[];
  redeemedCodes: string[];
}

const now = new Date('2026-09-05T00:00:00+08:00').toISOString();

export function mockVisual(seed: string, colors: [string, string, string]): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${colors[0]}"/><stop offset=".56" stop-color="${colors[1]}"/><stop offset="1" stop-color="${colors[2]}"/></linearGradient><filter id="b"><feGaussianBlur stdDeviation="36"/></filter></defs><rect width="960" height="960" fill="url(#g)"/><circle cx="710" cy="240" r="190" fill="none" stroke="#fff" stroke-opacity=".72" stroke-width="54"/><rect x="174" y="190" width="286" height="510" rx="118" fill="#fff" fill-opacity=".78"/><ellipse cx="360" cy="760" rx="260" ry="70" fill="#08090a" fill-opacity=".22" filter="url(#b)"/><path d="M0 780C210 650 380 940 610 760s350 20 350 20v180H0Z" fill="#fff" fill-opacity=".16"/><text x="62" y="88" fill="#fff" fill-opacity=".8" font-family="sans-serif" font-size="28">${seed}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

const visuals = [
  mockVisual('NO. 01', ['#f2a264', '#8f5ed8', '#3f284f']),
  mockVisual('NO. 02', ['#446e60', '#84af87', '#1f3031']),
  mockVisual('NO. 03', ['#ee7b6d', '#edbd68', '#5a392e']),
  mockVisual('NO. 04', ['#5d6fc4', '#bd8cec', '#302852']),
  mockVisual('NO. 05', ['#3a8f95', '#72d2bc', '#17434c']),
  mockVisual('NO. 06', ['#c95c6a', '#f2a96b', '#5d2437']),
  mockVisual('NO. 07', ['#7560bd', '#69a1cd', '#293257']),
  mockVisual('NO. 08', ['#d69b43', '#f0d286', '#5f4b31']),
  mockVisual('NO. 09', ['#a45164', '#d980a3', '#442337']),
  mockVisual('NO. 10', ['#3c7c62', '#9cc078', '#243b2c']),
  mockVisual('NO. 11', ['#b85b3b', '#f3a45c', '#542d27']),
  mockVisual('NO. 12', ['#496db0', '#8ab3dd', '#22314e']),
];

export function createSeedDb(): MockDatabase {
  const user: User = {
    id: 'user-demo',
    username: 'Mia Chen',
    email: 'demo@viviai.local',
    planId: 'plan-pro-month',
    planName: '专业版月卡',
    credits: 1120,
    frozenCredits: 0,
    concurrency: 8,
    inviteCode: 'VIVI-MIA88',
  };

  const models: ModelConfig[] = [
    {
      id: 'nano-banana-2',
      name: 'NanoBanana 2',
      description: '速度和效果兼顾，推荐使用',
      recommended: true,
      resolutions: ['1K', '2K', '4K'],
      ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      status: 'available',
    },
    {
      id: 'g-image-2',
      name: 'G-image 2',
      description: '擅长中文文字和海报',
      resolutions: ['1K', '2K', '4K'],
      qualities: ['high', 'medium', 'low'],
      ratios: ['21:9', '16:9', '3:2', '5:4', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16'],
      status: 'available',
    },
    {
      id: 'nano-banana-pro',
      name: 'NanoBanana Pro',
      description: '超强一致性',
      resolutions: ['1K'],
      ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
      status: 'available',
    },
    {
      id: 'nano-banana-2-lite',
      name: 'NanoBanana 2 Lite',
      description: '出图速度快',
      resolutions: ['1K'],
      ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
      status: 'available',
    },
    {
      id: 'nano-banana',
      name: 'NanoBanana',
      description: '一代模型，一致性好，不支持中文',
      resolutions: ['1K'],
      ratios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
      status: 'available',
    },
  ];

  const assets: ImageAsset[] = visuals.slice(0, 8).map((imageUrl, index) => ({
    id: `asset-${index + 1}`,
    name: ['琥珀香氛主视觉', '森林精华瓶', '暖光礼盒', '暮色护肤套装', '青瓷饮品', '珊瑚唇釉', '星夜耳机', '晨光咖啡'][index],
    imageUrl,
    thumbnailUrl: imageUrl,
    width: 2048,
    height: 2048,
    source: (['generation', 'remix', 'tool', 'generation', 'workflow', 'remix', 'tool', 'generation'] as const)[index],
    modelId: index % 2 ? 'g-image-2' : 'nano-banana-2',
    favorite: index === 1 || index === 5,
    createdAt: new Date(Date.parse(now) - index * 3_600_000).toISOString(),
    prompt: '商业产品摄影，克制留白，柔和轮廓光',
  }));

  const categories = ['电商视觉', '摄影写真', '平面设计', '插画漫画', '影视', '建筑家装'];
  const inspirations: Inspiration[] = visuals.map((imageUrl, index) => ({
    id: `inspiration-${index + 1}`,
    title: ['透明香氛', '雨林精华', '秋日礼盒', '紫色胶片', '海盐气泡', '珊瑚时刻', '极光科技', '晨间咖啡', '花漾海报', '自然护肤', '暖调餐饮', '蓝调空间'][index],
    imageUrl,
    prompt: `商业视觉示例 ${index + 1}，主体清晰，光影有层次，保留文案安全区`,
    category: categories[index % categories.length],
    creator: ['Luna Studio', 'North Lab', '见山设计', 'Kite Visual'][index % 4],
    likes: 286 + index * 137,
    liked: index === 2,
  }));

  const templates: ViralTemplate[] = visuals.slice(0, 9).map((coverUrl, index) => ({
    id: `template-${index + 1}`,
    version: 1,
    title: ['高透香氛主图', '雨林成分视觉', '秋日礼盒海报', '紫调人物封面', '清爽饮品主图', '美妆质感海报', '科技新品封面', '精品咖啡菜单', '花漾节日营销'][index],
    coverUrl,
    category: ['电商主图', '商品海报', '小红书封面'][index % 3],
    platform: ['小红书', '淘宝', '抖音'][index % 3],
    industry: ['美妆', '食品', '消费电子'][index % 3],
    style: ['电影感', '自然系', '高级简约'][index % 3],
    tags: ['平台精选', index % 2 ? '含留白' : '高对比'],
    recommendedModelId: 'nano-banana-2',
    recommendedRatio: index % 3 === 0 ? '3:4' : '1:1',
    sourceType: 'platform',
    popularityLabel: index < 3 ? '近期热门' : '编辑精选',
    remixCount: 420 + index * 173,
    favorite: index === 2,
    status: 'active',
    analysis: {
      composition: index % 2 ? '主体居中，环形动线，顶部留白' : '主体偏左，斜向动线，右侧文案安全区',
      palette: ['#d8ff52', '#8067e8', '#f29a63'],
      lighting: '右上方柔光，边缘高光，背景低对比渐变',
      camera: '平视中景，轻微长焦压缩空间',
      typographyZone: '右上区域，四周保留 8% 安全边距',
      avoid: ['原图 Logo', '原文案', '水印', '可识别人物身份'],
    },
  }));

  const tools: ToolTemplate[] = [
    {
      id: 'product-polish',
      name: '产品精修',
      description: '优化材质、光线与商品轮廓，保持产品结构',
      category: '电商工具',
      isNew: true,
      coverUrl: visuals[1],
      maxAssets: 1,
      assetLabel: '产品图',
      fields: [
        {
          id: 'productType',
          label: '产品类型',
          type: 'select',
          required: true,
          options: ['护肤品', '服装', '食品', '消费电子'].map((value) => ({ label: value, value })),
        },
        { id: 'requirements', label: '额外要求', type: 'text', required: false },
      ],
      defaults: { modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1', count: 1 },
    },
    {
      id: 'photo-restore',
      name: '一键老照片修复',
      description: '修复划痕与模糊细节，可选择彩色或黑白',
      category: '摄影写真',
      coverUrl: visuals[7],
      maxAssets: 1,
      assetLabel: '老照片',
      fields: [
        {
          id: 'style',
          label: '修复风格',
          type: 'radio',
          required: true,
          options: [
            { label: '彩色', value: 'color' },
            { label: '黑白', value: 'mono' },
          ],
        },
      ],
      defaults: { modelId: 'nano-banana-2', resolution: '1K', ratio: '1:1', count: 1 },
    },
    {
      id: 'white-background',
      name: '电商白底图',
      description: '批量提取商品主体并生成规范白底图',
      category: '服装电商',
      coverUrl: visuals[4],
      maxAssets: 3,
      assetLabel: '产品图',
      fields: [
        {
          id: 'garmentType',
          label: '商品类型',
          type: 'select',
          required: true,
          options: ['自动', '上衣', '裤子', '裙子', '套装'].map((value) => ({ label: value, value })),
        },
      ],
      defaults: { modelId: 'nano-banana-2', resolution: '2K', ratio: '1:1', count: 1 },
    },
  ];

  const sharedFeatures = ['全部图片模型', '无水印', '商业使用权', '图片工具', '批量工作流', '客服支持'];
  const plans: Plan[] = [
    { id: 'plan-standard-month', name: '标准版月卡', cycle: 'month', price: 36.8, originalPrice: 50, credits: 1000, concurrency: 2, durationDays: 30, features: sharedFeatures },
    { id: 'plan-advanced-month', name: '高级版月卡', cycle: 'month', price: 68, originalPrice: 100, credits: 2000, concurrency: 4, durationDays: 30, features: sharedFeatures },
    { id: 'plan-pro-month', name: '专业版月卡', cycle: 'month', price: 168, originalPrice: 250, credits: 5000, concurrency: 8, durationDays: 30, features: sharedFeatures },
    { id: 'plan-standard-quarter', name: '标准版季卡', cycle: 'quarter', price: 99, originalPrice: 150, credits: 1000, concurrency: 2, durationDays: 90, features: sharedFeatures },
    { id: 'plan-advanced-quarter', name: '高级版季卡', cycle: 'quarter', price: 196, originalPrice: 300, credits: 2000, concurrency: 4, durationDays: 90, features: sharedFeatures },
    { id: 'plan-pro-quarter', name: '专业版季卡', cycle: 'quarter', price: 486, originalPrice: 750, credits: 5000, concurrency: 8, durationDays: 90, features: sharedFeatures },
    { id: 'plan-standard-year', name: '标准版年卡', cycle: 'year', price: 380, originalPrice: 600, credits: 1000, concurrency: 4, durationDays: 365, features: sharedFeatures },
    { id: 'plan-advanced-year', name: '高级版年卡', cycle: 'year', price: 726, originalPrice: 1200, credits: 2000, concurrency: 6, durationDays: 365, features: sharedFeatures },
    { id: 'plan-pro-year', name: '专业版年卡', cycle: 'year', price: 1688, originalPrice: 3000, credits: 5000, concurrency: 10, durationDays: 365, features: sharedFeatures },
    { id: 'plan-enterprise', name: '企业版', cycle: 'enterprise', price: null, originalPrice: null, credits: null, concurrency: null, durationDays: null, features: ['定制积分与并发', '团队协作', '专属支持', '合同与发票'] },
  ];

  return {
    sessionUserId: user.id,
    user,
    credentialHash: '0ead2060b65992dca4769af601a1b3a35ef38cfad2c2c465bb160ea764157c5d',
    models,
    tasks: [],
    assets,
    deletedAssets: [],
    inspirations,
    templates,
    tools,
    workflows: [],
    batches: [],
    plans,
    orders: [],
    ledger: [
      { id: 'ledger-1', type: 'purchase', description: '专业版月卡到账', delta: 5000, balance: 5000, createdAt: now },
      { id: 'ledger-2', type: 'consume', description: '历史图片生成', delta: -3880, balance: 1120, createdAt: now },
    ],
    notifications: [
      { id: 'notice-1', type: 'system', title: '欢迎来到 VIVIAI', content: '你的创作工作台已经准备好。', read: false, createdAt: now },
    ],
    invites: [
      { id: 'invite-1', username: 'Lin', reward: 10, status: 'rewarded', createdAt: now },
      { id: 'invite-2', username: 'Aster', reward: 10, status: 'rewarded', createdAt: now },
    ],
    redeemedCodes: [],
  };
}

export function getFixtureVisual(index: number): string {
  return visuals[index % visuals.length];
}
