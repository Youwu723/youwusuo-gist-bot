#!/usr/bin/env node
/**
 * 釉雾所 · 每日云端选题自动生成器
 * ------------------------------------------------------------
 * 功能：
 *  1. 抓取抖音 / 微博 / B站 / 知乎 / 财联社 / 百度 等热榜（keyless 公共聚合接口）
 *  2. 用 AI（OpenAI 兼容接口，可选）把热榜改写成贴合你赛道的内容：
 *       10 条选题灵感 + 10 条二创角度 + 10 条热点素材(hot) + 20 条新闻(news)
 *  3. 未配置 AI Key 时，使用内置模板 + 真实热榜回落，照样产出合规 JSON
 *  4. 写入 GitHub Gist（公开），网页端「⚙️ 配置 Gist」填入 Raw 链接即可每天自动读到
 *
 * 运行：
 *  - 本地预览：   DRY_RUN=1 node generate_feed.js        （只写本地 gist-feed.json，不推 Gist）
 *  - GitHub Actions 中：配置 Secrets 后自动每日推送
 *
 * 所需环境变量（均可选/按需）：
 *  GIST_TOKEN     GitHub Personal Access Token，需勾选 gist 权限（必填才能推 Gist）
 *  GIST_ID        目标 Gist ID（留空则首次运行自动新建一个公开 Gist）
 *  GIST_FILENAME  写入的文件名，默认 feed.json
 *  OPENAI_API_KEY 可选，配置后启用真正的 AI 改写
 *  OPENAI_BASE_URL 可选，默认 https://api.openai.com/v1
 *  OPENAI_MODEL   可选，默认 gpt-4o-mini
 *  DRY_RUN=1      只生成本地文件，不调用 Gist API
 */

const fs = require("fs");
const path = require("path");

const DRY_RUN = process.env.DRY_RUN === "1";
const GIST_TOKEN = process.env.GIST_TOKEN || "";
const GIST_ID = process.env.GIST_ID || "";
const GIST_FILENAME = process.env.GIST_FILENAME || "feed.json";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// 你的赛道（与网页端热点二创板块一致）。AI 改写与模板都会围绕这些赛道展开。
const TRACKS = ["减肥", "小说推文", "漫剧", "影视剪辑", "学习成长", "女性成长", "带货"];

function todayKey(d = new Date()) {
  // 统一用北京时间（UTC+8），避免 CI/服务器为 UTC 时区导致日期“慢一天”
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return bj.getUTCFullYear() + "-" + String(bj.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj.getUTCDate()).padStart(2, "0");
}

async function fetchJSON(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "youwusuo-gist-bot/1.0" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    console.warn(`  ⚠️ 抓取失败 ${url}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- 热榜源（vvhan 公共聚合，无需 Key）----
const SOURCES = [
  { name: "抖音", url: "https://api.vvhan.com/api/hotlist/douyin", cat: ["减肥", "小说推文", "漫剧", "影视剪辑", "女性成长", "带货"] },
  { name: "微博", url: "https://api.vvhan.com/api/hotlist/weibo", cat: ["减肥", "女性成长", "学习成长"] },
  { name: "哔哩哔哩", url: "https://api.vvhan.com/api/hotlist/bili", cat: ["影视剪辑", "学习成长", "减肥"] },
  { name: "知乎", url: "https://api.vvhan.com/api/hotlist/zhihu", cat: ["学习成长", "女性成长"] },
  { name: "财联社", url: "https://api.vvhan.com/api/hotlist/cls", cat: ["财经"] },
  { name: "百度", url: "https://api.vvhan.com/api/hotlist/baidu", cat: ["热点", "社会"] },
];

function normItem(item) {
  if (!item) return null;
  const title = item.title || item.word || item.hotword || item.name || "";
  if (!title) return null;
  const hot = item.hot ?? item.num ?? item.weight ?? item.readCount ?? "";
  const url = item.url || item.mobilUrl || item.link || "";
  return { title: String(title).trim(), hot: hot === "" ? "" : String(hot), url: String(url).trim(), raw: item };
}

async function collectHot() {
  const bySource = {};
  for (const s of SOURCES) {
    const data = await fetchJSON(s.url);
    const list = (data && (data.data || data.list || data.result || [])) || [];
    const items = list.map(normItem).filter(Boolean).slice(0, 30);
    bySource[s.name] = { cat: s.cat, items };
    console.log(`  ✓ ${s.name}: ${items.length} 条`);
  }
  return bySource;
}

// ---- 平台搜索链接（hot 缺 url 时也能跳转）----
const SEARCH_URL = {
  "抖音": (kw) => "https://www.douyin.com/search/" + encodeURIComponent(kw),
  "快手": (kw) => "https://www.kuaishou.com/search/video?searchKey=" + encodeURIComponent(kw),
  "微博": (kw) => "https://s.weibo.com/weibo?q=" + encodeURIComponent(kw),
  "哔哩哔哩": (kw) => "https://search.bilibili.com/all?keyword=" + encodeURIComponent(kw),
  "B站": (kw) => "https://search.bilibili.com/all?keyword=" + encodeURIComponent(kw),
  "小红书": (kw) => "https://www.xiaohongshu.com/search_result?keyword=" + encodeURIComponent(kw),
  "知乎": (kw) => "https://www.zhihu.com/search?type=content&q=" + encodeURIComponent(kw),
  "财联社": (kw) => "https://www.cls.cn/search?keyword=" + encodeURIComponent(kw),
  "百度": (kw) => "https://www.baidu.com/s?wd=" + encodeURIComponent(kw),
};
function searchUrl(platform, kw) {
  const fn = SEARCH_URL[platform] || SEARCH_URL["百度"];
  return fn(kw);
}

/** 关键词命中赛道归类 */
function classify(title) {
  const kw = {
    减肥: ["减肥", "减脂", "瘦身", "体重", "健身", "运动", "卡路里", "断食", "胖", "瘦", "身材"],
    小说推文: ["小说", "推文", "网文", "知乎", "连载", "爽文", "短剧", "漫剧"],
    漫剧: ["漫剧", "漫画", "动漫", "二次元", "短剧"],
    影视剪辑: ["电影", "剧", "综艺", "剪辑", "影视", "二创", "解说"],
    学习成长: ["学习", "考试", "考研", "英语", "证书", "副业", "技能", "职场", "读书"],
    女性成长: ["女性", "30岁", "重启", "独立", "穿搭", "化妆", "情感", "自律"],
    带货: ["带货", "好物", "开箱", "种草", "电商", "直播"],
    财经: ["股市", "基金", "财经", "A股", "金价", "经济", "降准", "利率", "财报", "楼市"],
  };
  for (const cat of TRACKS.concat(["财经"])) {
    if ((kw[cat] || []).some(k => title.includes(k))) return cat;
  }
  return "热点";
}

// ---- 内置兜底素材库（接口全挂时也能产出合规内容）----
const FALLBACK_HOT = [
  { title: "14天轻断食实测，我瘦了8斤", platform: "抖音", cat: "减肥" },
  { title: "大基数减肥不伤膝盖的燃脂操火了", platform: "抖音", cat: "减肥" },
  { title: "小说推文一条视频赚了3000块？", platform: "哔哩哔哩", cat: "小说推文" },
  { title: "这部漫剧的二创剪辑全网刷屏", platform: "微博", cat: "漫剧" },
  { title: "减脂期怎么吃不饿还能瘦", platform: "哔哩哔哩", cat: "减肥" },
  { title: "30岁女性如何重启人生", platform: "知乎", cat: "女性成长" },
  { title: "自律100天，我的人生变了", platform: "小红书", cat: "女性成长" },
  { title: "影视剪辑素材去哪找", platform: "知乎", cat: "影视剪辑" },
  { title: "平价好物开箱：百元内提升幸福感", platform: "抖音", cat: "带货" },
  { title: "爆款推文钩子怎么写？3个公式", platform: "知乎", cat: "小说推文" },
];
const FALLBACK_TOPICS = [
  "大基数减脂第30天实测：不节食掉了9斤的三餐怎么吃",
  "抖音爆火的『8分钟晨间燃脂操』适合宝妈的改良版",
  "推文赛道新风口：漫剧解说号 7 天起号复盘",
  "减脂期外卖红黑榜：打工人照抄不胖清单",
  "小说推文如何选书？3 个数据指标教你避开扑街文",
  "腰腹训练不伤腰版本：久坐党每天10分钟",
  "漫剧二创：一条『反转结局』剪辑拿下50万播放的结构拆解",
  "减肥平台期自救指南：碳循环的简化操作",
  "女性成长号爆款公式：『30岁重启人生』系列选题",
  "推文配音进阶：AI配音+情绪停顿让完播率翻倍",
];
const FALLBACK_ANGLES = [
  "0-3s 用体重秤数字特写做钩子，3-15s 讲踩坑经历，15-40s 给三餐模板，40-60s 评论区领食谱",
  "热榜标题直接做封面大字，首帧强对比（胖→瘦）",
  "漫剧解说用『如果是你会怎么选』互动开头，结尾投票逼互动",
  "外卖测评用『红黑榜』二分结构，节奏快、信息密度高",
  "选书方法论用『数据面板截图』增强可信度",
  "跟练类视频用『第1天vs第7天』对比增强留存",
  "反转结局剪辑：先剪高潮冲突，正片信息后置",
  "平台期内容用『我也卡了28天』共情开头再给方法",
  "女性成长系列做成连载专栏，片尾预告下一集",
  "配音教学用『修改前vs修改后』AB对比试听",
];
// 兜底新闻池（接口全挂时保证 20 条不重复、分类正确）
const FALLBACK_FINANCE = [
  "A股三大指数集体收涨，成交额重回万亿",
  "央行宣布全面降准0.5个百分点",
  "国际金价创年内新高，避险情绪升温",
  "新能源板块领涨，机构看好下半年行情",
  "多家银行下调存款利率，理财收益承压",
  "6月CPI同比上涨，通胀温和可控",
  "美联储释放降息信号，人民币短线走强",
];
const FALLBACK_GENERAL = [
  "三伏天养生指南：这5类人最该注意",
  "暑期亲子游爆火，这些小众目的地人少景美",
  "国产动画电影票房破纪录，国漫崛起",
  "专家提醒：长期熬夜正在透支你的免疫力",
  "高考志愿填报进入尾声，这些专业成黑马",
  "年轻人开始流行『公园20分钟效应』",
  "旧物改造走红：闲置物品的第二春",
  "城市夜经济升温，深夜食堂成新地标",
  "AI 工具实测：打工人效率翻倍的隐藏用法",
  "极简生活一年后，我扔掉了这些东西",
  "职场新人避坑指南：前3个月别踩这些雷",
  "秋季穿搭提前看：温柔大地色回归",
  "在家就能做的低成本健身计划",
  "读书复盘：今年最值得重读的三本书",
];

// ---- 模板方式生成（无 AI Key 时）----
function buildTemplate(bySource) {
  // hot：优先真实热榜命中赛道，不足用兜底补足
  const hot = [];
  const seen = new Set();
  for (const s of SOURCES) {
    const { cat, items } = bySource[s.name] || {};
    for (const it of items) {
      const c = classify(it.title);
      if (c === "热点" || c === "社会") continue; // 只保留与赛道相关的
      const key = it.title.slice(0, 12);
      if (seen.has(key)) continue;
      seen.add(key);
      hot.push({ title: it.title, platform: s.name, url: it.url || searchUrl(s.name, it.title), heat: it.hot || "热", category: c });
      if (hot.length >= 10) break;
    }
    if (hot.length >= 10) break;
  }
  while (hot.length < 10) {
    const f = FALLBACK_HOT[hot.length % FALLBACK_HOT.length];
    hot.push({ title: f.title, platform: f.platform, url: searchUrl(f.platform, f.title), heat: "热", category: f.cat });
  }

  // news：财经优先（保证≥6条），其余综合，凑满 20 条（去重）
  const news = [];
  const used = new Set();
  const pushNews = (title, source, kw, cat, summary) => {
    const key = String(title).slice(0, 16);
    if (used.has(key) || !title) return;
    used.add(key);
    news.push({ title, source, kw: kw || title, cat, summary: summary || ("今日精选：" + title + "。"), time: "今日" });
  };
  // 财经池：真实财联社优先 + 兜底池，至少保证 8 条财经
  const financeItems = [];
  (bySource["财联社"]?.items || []).forEach(it => financeItems.push({ title: it.title, source: "财联社", kw: it.title, summary: "今日财经热点：" + it.title + "。" }));
  FALLBACK_FINANCE.forEach(t => financeItems.push({ title: t, source: "财经快讯", kw: t, summary: "财经观察：" + t + "。" }));
  // 综合池：真实微博/百度/知乎/B站 + 兜底
  const generalItems = [];
  for (const s of ["微博", "百度", "知乎", "哔哩哔哩"]) {
    (bySource[s]?.items || []).forEach(it => generalItems.push({ title: it.title, source: s, kw: it.title, summary: "今日热搜：" + it.title + "。", cat: classify(it.title) }));
  }
  FALLBACK_GENERAL.forEach(t => generalItems.push({ title: t, source: "热点速递", kw: t, summary: "热点内容：" + t + "。", cat: classify(t) }));
  const financePicked = financeItems.slice(0, 8);
  const rest = generalItems.filter(g => !financePicked.some(f => f.title.slice(0, 16) === g.title.slice(0, 16)));
  for (const f of financePicked) pushNews(f.title, f.source, f.kw, "财经", f.summary);
  for (const g of rest) pushNews(g.title, g.source, g.kw, g.cat === "财经" ? "财经" : "热点", g.summary);
  if (news.length > 20) news.length = 20;

  return {
    topics: FALLBACK_TOPICS.slice(),
    angles: FALLBACK_ANGLES.slice(),
    hot,
    news,
  };
}

// ---- AI 方式生成（有 Key 时）----
async function buildWithAI(bySource) {
  const ctxTitles = [];
  for (const s of SOURCES) {
    (bySource[s.name]?.items || []).slice(0, 12).forEach(it => ctxTitles.push(`[${s.name}] ${it.title}`));
  }
  const prompt = `你是短视频选题策划。基于下面真实热榜，为「${TRACKS.join("、")}」赛道，产出贴合热点的内容。
只输出 JSON，不要任何解释或代码块标记。结构必须严格如下：
{
 "topics": [10个字符串，每条是具体选题灵感，要结合热榜且可拍成视频],
 "angles": [10个字符串，每条是二创角度/脚本结构，含前3秒钩子与节奏],
 "hot": [10个对象 {title, platform(抖音/微博/哔哩哔哩/知乎/小红书/财联社之一), url(该平台搜索链接), heat(热/数字), category(减肥/小说推文/漫剧/影视剪辑/学习成长/女性成长/带货/财经之一)}],
 "news": [20个对象 {title, source(平台名), kw, cat(财经/热点/科技/社会), summary(一句话)}，其中至少6条 cat 为 财经]
}
真实热榜：
${ctxTitles.slice(0, 60).join("\n")}`;

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_API_KEY },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("OpenAI HTTP " + res.status);
  const j = await res.json();
  const text = j.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(text);
  // 兜底补全字段
  const hot = (parsed.hot || []).slice(0, 10).map(h => ({
    title: h.title, platform: h.platform || "抖音",
    url: h.url || searchUrl(h.platform || "抖音", h.title),
    heat: h.heat || "热", category: h.category || classify(h.title),
  }));
  const news = (parsed.news || []).slice(0, 20).map(n => ({
    title: n.title, source: n.source || "热榜", kw: n.kw || n.title,
    cat: n.cat || "热点", summary: n.summary || ("今日热点：" + n.title + "。"), time: "今日",
  }));
  while (hot.length < 10) {
    const f = FALLBACK_HOT[hot.length % FALLBACK_HOT.length];
    hot.push({ title: f.title, platform: f.platform, url: searchUrl(f.platform, f.title), heat: "热", category: f.cat });
  }
  while (news.length < 20) {
    const pool = news.length < 8 ? FALLBACK_FINANCE : FALLBACK_GENERAL;
    const f = pool[news.length % pool.length];
    news.push({ title: f, source: news.length < 8 ? "财经快讯" : "热点速递", kw: f, cat: news.length < 8 ? "财经" : "热点", summary: (news.length < 8 ? "财经观察：" : "热点内容：") + f + "。", time: "今日" });
  }
  return {
    topics: (parsed.topics || []).slice(0, 10),
    angles: (parsed.angles || []).slice(0, 10),
    hot,
    news,
  };
}

// ---- 推送到 Gist ----
async function pushGist(content) {
  if (DRY_RUN) {
    const out = path.join(__dirname, "gist-feed.json");
    fs.writeFileSync(out, content, "utf8");
    console.log(`  💾 DRY_RUN：已写入本地 ${out}`);
    return null;
  }
  if (!GIST_TOKEN) {
    const out = path.join(__dirname, "gist-feed.json");
    fs.writeFileSync(out, content, "utf8");
    console.warn("  ⚠️ 未设置 GIST_TOKEN，已写入本地 gist-feed.json（未推送 Gist）");
    return null;
  }
  const body = { files: { [GIST_FILENAME]: { content } } };
  if (GIST_ID) {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH", headers: { Authorization: "Bearer " + GIST_TOKEN, "Content-Type": "application/json", "User-Agent": "youwusuo-gist-bot" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("PATCH gist HTTP " + res.status);
    const j = await res.json();
    console.log(`  ☁️ 已更新 Gist: ${j.html_url}`);
    return j;
  } else {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST", headers: { Authorization: "Bearer " + GIST_TOKEN, "Content-Type": "application/json", "User-Agent": "youwusuo-gist-bot" },
      body: JSON.stringify({ ...body, public: true, description: "釉雾所每日云端选题（自动生成）" }),
    });
    if (!res.ok) throw new Error("POST gist HTTP " + res.status);
    const j = await res.json();
    console.log(`  ☁️ 已新建公开 Gist: ${j.html_url}`);
    console.log(`  👉 请把下面这行加入 GitHub Secrets 的 GIST_ID（下次直接更新而非新建）：`);
    console.log(`     ${j.id}`);
    return j;
  }
}

(async () => {
  console.log("▶ 开始抓取热榜…");
  const bySource = await collectHot();
  let feed;
  if (OPENAI_API_KEY) {
    try {
      console.log("▶ 使用 AI 改写（" + OPENAI_MODEL + "）…");
      feed = await buildWithAI(bySource);
    } catch (e) {
      console.warn("  ⚠️ AI 改写失败，改用模板：" + e.message);
      feed = buildTemplate(bySource);
    }
  } else {
    console.log("▶ 未配置 AI Key，使用模板 + 真实热榜生成…");
    feed = buildTemplate(bySource);
  }

  const payload = {
    date: todayKey(),
    generatedBy: "釉雾所每日热榜抓取任务",
    topics: feed.topics.slice(0, 10),
    angles: feed.angles.slice(0, 10),
    hot: feed.hot.slice(0, 10),
    news: feed.news.slice(0, 20),
  };
  const content = JSON.stringify(payload, null, 2);

  // 基本校验
  if (payload.topics.length < 10 || payload.angles.length < 10 || payload.hot.length < 10 || payload.news.length < 20) {
    console.error("  ✗ 生成内容不完整，终止推送"); process.exit(1);
  }
  console.log(`  ✓ 产出：选题 ${payload.topics.length} / 角度 ${payload.angles.length} / 热点 ${payload.hot.length} / 新闻 ${payload.news.length}（财经 ${payload.news.filter(n => n.cat === "财经").length}）`);

  const j = await pushGist(content);
  if (j && j.files && j.files[GIST_FILENAME]) {
    const raw = `https://gist.githubusercontent.com/${j.owner ? j.owner.login : "匿名"}/${j.id}/raw/${GIST_FILENAME}`;
    console.log("  🔗 Raw 链接（填到网页端 ⚙️ 配置 Gist）：");
    console.log("     " + raw);
  }
  console.log("✅ 完成");
})();
