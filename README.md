# 釉雾所 · 每日云端选题自动生成器

每天自动抓取 **抖音 / 微博 / B站 / 知乎 / 财联社 / 百度** 热榜，改写成贴合你赛道的内容
（10 选题灵感 + 10 二创角度 + 10 热点素材 + 20 条新闻），**推送到公开 GitHub Gist**，
网页端「釉雾所」默认读这个 Gist，做到**每日自动更新、带刷新按钮**。

---

## 一、准备（一次性）

1. **新建一个 GitHub 仓库**（任意名字，比如 `youwusuo-gist-bot`），把本目录文件推上去。
2. **生成 Token**：GitHub → Settings → Developer settings → Personal access tokens →
   Tokens (classic) → Generate new token，**只勾选 `gist`** 权限，复制 token。
3. 在本仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加：
   - `GIST_TOKEN` = 上面的 token（必填）
   - `GIST_ID` = 留空（首次运行会自动新建一个公开 Gist，控制台会打印新 id，回来填这里，之后就只更新不新建）
   - `GIST_FILENAME` = `feed.json`（默认）
   - `OPENAI_API_KEY`（可选）：填了才用真 AI 改写；不填则用「模板 + 真实热榜」回落，照样合规
   - `OPENAI_BASE_URL` / `OPENAI_MODEL`（可选）：自定义模型

> 不填 `OPENAI_API_KEY` 也能跑：脚本会基于真实热榜 + 内置模板生成合规 JSON。

---

## 二、触发方式

- **每天自动**：仓库 Actions 按 `daily-gist.yml` 里的 cron（默认北京时间 08:00）运行。
- **手动**：仓库 → Actions → 选「釉雾所·每日云端选题推送」→ Run workflow。

---

## 三、网页端配置（让 App 读你的 Gist）

脚本首次运行会新建 Gist 并打印 Raw 链接，形如：

```
https://gist.githubusercontent.com/<用户名>/<gist_id>/raw/feed.json
```

在「釉雾所」App 内：
1. 热点二创 / 每日新闻 页 → 点 **⚙️ 配置 Gist**
2. 粘贴上面的 Raw 链接 → 保存并拉取
3. 之后每天 App 打开会自动读最新 Gist；也可点 **🔄 刷新云端选题 / 刷新今日资讯** 手动刷新

> 不配置也能用：App 自带 `data/gist-feed.json` 默认值，开箱即用。

---

## 四、本地预览 / 调试

```bash
# 只生成到本地 gist-feed.json，不推 Gist
DRY_RUN=1 node generate_feed.js

# 或用 npm
npm run dry
```

需要真实推送时在本地：

```bash
export GIST_TOKEN=ghp_xxx
export GIST_ID=            # 留空则新建
node generate_feed.js
```

---

## 五、产出 JSON 结构（与 App 对齐）

```json
{
  "date": "2026-07-29",
  "generatedBy": "釉雾所每日热榜抓取任务",
  "topics": ["10 条选题灵感（字符串）"],
  "angles": ["10 条二创角度（字符串）"],
  "hot":    [{ "title": "", "platform": "抖音", "url": "", "heat": "热", "category": "减肥" }],
  "news":   [{ "title": "", "source": "", "kw": "", "cat": "财经", "summary": "", "time": "今日" }]
}
```
