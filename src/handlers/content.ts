import { neon } from "@neondatabase/serverless";
import { updateTaskStatus, saveReport, withModelMetrics, failTask } from "../lib/db";
import { claudeCompletionWithMeta } from "../lib/ai";
import { localeInstruction } from "../lib/locale";

interface Env {
  DATABASE_URL: string;
  CONTENT_DATABASE_URL?: string;
  CONTENT_DEFAULT_BRAND_NAME?: string;
  CONTENT_DEFAULT_BRAND_DOMAIN?: string;
  CONTENT_DEFAULT_CONTACT_PHONE?: string;
  CONTENT_DEFAULT_AUDIENCE?: string;
  CONTENT_DEFAULT_MARKET_REGION?: string;
  AI_GATEWAY_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
}

interface ContentConfig {
  content_db_url?: string;
  brand_name?: string;
  brand_domain?: string;
  contact_phone?: string;
  audience?: string;
  market_region?: string;
  profile?: {
    brand_name?: string;
    brand_domain?: string;
    contact_phone?: string;
    audience?: string;
    market_region?: string;
  };
  [key: string]: unknown;
}

// Topics pool — rotate through these for weekly content
const TOPIC_POOL = [
  {
    theme: "机场接送",
    angles: [
      "国际航班入境流程详解",
      "SFO各航站楼接机指南",
      "OAK奥克兰机场接机攻略",
      "SJC圣何塞机场停车vs专车对比",
      "带老人小孩接机注意事项",
    ],
  },
  {
    theme: "酒庄旅游",
    angles: [
      "纳帕vs索诺玛哪个更值得去",
      "第一次去酒庄品酒礼仪",
      "纳帕谷最适合拍照的酒庄",
      "酒庄一日游最佳路线规划",
      "秋季葡萄收获季特别体验",
    ],
  },
  {
    theme: "湾区出行",
    angles: [
      "硅谷科技公司参观路线",
      "旧金山最适合散步的街区",
      "湾区赏花季最佳地点",
      "周末带娃好去处TOP10",
      "湾区夜景最佳观赏点",
    ],
  },
  {
    theme: "长途包车",
    angles: [
      "优胜美地一日游vs两日游",
      "一号公路自驾vs包车对比",
      "洛杉矶往返最佳方案",
      "太浩湖冬季出行安全提示",
      "Outlets购物包车省时攻略",
    ],
  },
  {
    theme: "商务出行",
    angles: [
      "硅谷商务拜访交通方案",
      "会议接送注意事项",
      "投资人路演湾区行程安排",
      "科技展会出行指南",
      "商务晚宴用车礼仪",
    ],
  },
  {
    theme: "旅行实用",
    angles: [
      "加州小费文化指南",
      "湾区天气穿衣指南",
      "旧金山公共交通vs专车",
      "带宠物出行注意事项",
      "节假日出行提前预约的重要性",
    ],
  },
];

// Unsplash cover images by theme
const COVER_IMAGES: Record<string, string[]> = {
  机场接送: [
    "https://images.unsplash.com/photo-1556388158-158ea5ccacbd?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1436491865332-7a61a109db05?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1529074963764-98f45c47344b?auto=format&fit=crop&q=80&w=800",
  ],
  酒庄旅游: [
    "https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1598306442928-4d90f32c6866?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1560179707-f14e90ef3623?auto=format&fit=crop&q=80&w=800",
  ],
  湾区出行: [
    "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1449965408869-eaa3f722e40d?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?auto=format&fit=crop&q=80&w=800",
  ],
  长途包车: [
    "https://images.unsplash.com/photo-1605833556294-ea5c7a74f57d?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1510414842594-a61c69b5ae57?auto=format&fit=crop&q=80&w=800",
  ],
  商务出行: [
    "https://images.unsplash.com/photo-1560179707-f14e90ef3623?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1541625602330-2277a4c46182?auto=format&fit=crop&q=80&w=800",
  ],
  旅行实用: [
    "https://images.unsplash.com/photo-1476514525535-07fb3b4ae5f1?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&q=80&w=800",
    "https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&q=80&w=800",
  ],
};

function pickTopic(weekNumber: number) {
  const themeIndex = weekNumber % TOPIC_POOL.length;
  const theme = TOPIC_POOL[themeIndex];
  const angleIndex = Math.floor(weekNumber / TOPIC_POOL.length) % theme.angles.length;
  return { theme: theme.theme, angle: theme.angles[angleIndex] };
}

function pickCover(theme: string, weekNumber: number): string {
  const images = COVER_IMAGES[theme] || COVER_IMAGES["湾区出行"];
  return images[weekNumber % images.length];
}

function getContentProfile(env: Env, config: ContentConfig) {
  const profile = config.profile || {};
  return {
    brandName:
      profile.brand_name ||
      config.brand_name ||
      env.CONTENT_DEFAULT_BRAND_NAME ||
      "Your Brand",
    brandDomain:
      profile.brand_domain ||
      config.brand_domain ||
      env.CONTENT_DEFAULT_BRAND_DOMAIN ||
      "example.com",
    contactPhone:
      profile.contact_phone ||
      config.contact_phone ||
      env.CONTENT_DEFAULT_CONTACT_PHONE ||
      "+1-000-000-0000",
    audience:
      profile.audience ||
      config.audience ||
      env.CONTENT_DEFAULT_AUDIENCE ||
      "本地中文用户",
    marketRegion:
      profile.market_region ||
      config.market_region ||
      env.CONTENT_DEFAULT_MARKET_REGION ||
      "你的目标城市",
  };
}

// Task 0: Generate a blog article and insert into content DB
async function generateArticle(env: Env, agentId: number, config: ContentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 0, "in_progress");

  const contentDbUrl =
    env.CONTENT_DATABASE_URL ||
    config.content_db_url ||
    "";
  if (!contentDbUrl) {
    const msg = "CONTENT_DATABASE_URL not configured";
    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", msg);
    return { error: msg };
  }

  // Determine which topic to write about based on current week
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const { theme, angle } = pickTopic(weekNumber);
  const cover = pickCover(theme, weekNumber);

  const { brandName, brandDomain, contactPhone, audience, marketRegion } = getContentProfile(env, config);
  const userLocale = (config.locale as string) || "en";
  const langHint = localeInstruction(userLocale);

  const prompt = `你是 ${brandName} 的内容运营，服务 ${marketRegion} 的 ${audience}。

请写一篇小红书风格的攻略文章：

主题：${theme}
角度：${angle}

要求：
1. 标题用emoji开头，吸引点击，15字以内
2. 正文800-1200字，分段清晰，多用emoji和符号排版
3. 内容要实用、接地气，像朋友分享经验
4. 自然融入 ${brandName} 的服务（不要太硬广）
5. 文末加上联系方式：📞 ${contactPhone} 🌐 ${brandDomain}
6. 最后加5-8个相关hashtag，用#开头

请直接输出，格式：
第一行：标题
空一行
正文内容（含hashtag）
${langHint}`;

  try {
    const preferredModel = String(config.model || "auto");
    const { content, model } = await claudeCompletionWithMeta(env, prompt, 2000, preferredModel);

    // Parse title and body
    const lines = content.trim().split("\n");
    const title = lines[0].trim();
    const body = lines.slice(1).join("\n").trim();

    // Get next sort_order
    const contentSql = neon(contentDbUrl);
    const maxRows = await contentSql`SELECT COALESCE(MAX(sort_order), 0) + 1 as next_sort FROM xhs_notes`;
    const nextSort = maxRows[0].next_sort as number;

    // Insert article
    const rows = await contentSql`
      INSERT INTO xhs_notes (title, cover, url, likes, content, images, sort_order)
      VALUES (${title}, ${cover}, ${"https://www.xiaohongshu.com/explore/"}, ${"0"}, ${body}, ${"[]"}, ${nextSort})
      RETURNING id
    `;

    const articleId = rows[0].id;
    const summary = `Generated article: "${title}" (ID: ${articleId}, theme: ${theme})`;

    await updateTaskStatus(env.DATABASE_URL, agentId, 0, "completed", summary);
    await saveReport(env.DATABASE_URL, agentId, "Content Generation", summary, withModelMetrics({
      article_id: articleId,
      theme,
      angle,
      title,
      word_count: body.length,
    }, preferredModel, model));

    return { articleId, title, theme, angle };
  } catch (e) {
    const msg = `Content generation failed: ${e}`;
    await failTask(env.DATABASE_URL, agentId, 0, "Content Generation", msg, "auto");
    return { error: msg };
  }
}

// Task 1: Publish to backlink platforms (future)
async function publishBacklinks(env: Env, agentId: number, config: ContentConfig) {
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "in_progress");

  // TODO: integrate with xpilot SEO backlinks skill
  // - Blogger, Medium, Dev.to, Telegra.ph, WordPress
  // - Each post links back to {brand_domain}/blog/[id]

  const summary = "Backlink publishing: not yet implemented";
  await updateTaskStatus(env.DATABASE_URL, agentId, 1, "completed", summary);
  return { status: "pending_implementation" };
}

export async function handleContent(
  env: Env,
  agentId: number,
  taskIndex: number,
  config: Record<string, unknown>
) {
  const contentConfig = config as ContentConfig;
  switch (taskIndex) {
    case 0:
      return generateArticle(env, agentId, contentConfig);
    case 1:
      return publishBacklinks(env, agentId, contentConfig);
    default:
      return { error: `Task ${taskIndex} not implemented` };
  }
}
