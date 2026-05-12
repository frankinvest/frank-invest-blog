---
name: red-ring-scraper
description: 抓取小红圈帖子正文和图片，上传到 GitHub。触发条件：用户说"抓取财经早餐"、"提取小红圈帖子"、"下载 red-ring 图片"、或需要从 https://www.red-ring.cn/post/XXX 获取内容。
---

> ⚠️ **强制规则**：所有截图任务必须使用 `screenshot-master__capture_page` MCP 工具，禁止用 `browser(action=screenshot)` 替代。

# red-ring-scraper

抓取小红圈（red-ring.cn）帖子正文（含图片）和完整评论区，上传到 GitHub 公网可访问。

## 核心问题

小红圈的图片 URL 含临时 token（`https://private.red-ring.cn/xxx?e=xxx&token=xxx`），**直接 curl/wget 会 403**。只有浏览器的登录态 Cookie 才能访问。

## 仓库配置

- **图片仓库**：`frankinvest/caijing-daily`（main 分支，图片直接放根目录）
- **GitHub Token**：`ghp_REDACTED`
- **公网访问**：`https://frankinvest.github.io/caijing-daily/{文件名}`
- **HTML 中图片路径**：相对路径 `./caijing_YYYYMMDD_img_NN.{jpg|png}`，与 HTML 文件同目录，无需 CDN

## 工作流

### Step 1: 打开帖子，滚动加载所有评论

在 browser 中打开帖子后执行：

```javascript
window.scrollTo(0, document.body.scrollHeight)
```

等待评论加载完成（可重复滚动）。

### Step 2a: 建立图文对应关系（关键步骤）

**⚠️ 常见错误**：只用 `querySelectorAll` 遍历或递归 `TreeWalker` 提取图片，正文图片嵌套在深层富文本容器中，容易漏掉或打乱顺序，导致图文错配。

**正确方法：视口滚动 + 上下文匹配**

执行以下脚本，按视觉顺序记录每张图片及其周围文字：

```javascript
(function() {
  // 必须滚动页面，否则懒加载图片未进入 DOM
  for(var i=0;i<3;i++) window.scrollTo(0, document.body.scrollHeight);
  
  var results = [];
  var viewportHeight = window.innerHeight;
  var scrollStep = viewportHeight * 0.8;
  var maxScroll = document.body.scrollHeight;

  for (var scrollY = 0; scrollY < maxScroll; scrollY += scrollStep) {
    window.scrollTo(0, scrollY);
    document.querySelectorAll('img').forEach(function(img) {
      var src = img.src || '';
      if (src.includes('private.red-ring') && !src.includes('avatar')) {
        var rect = img.getBoundingClientRect();
        if (rect.top < viewportHeight && rect.bottom > 0) {
          var id = src.split('/').pop().split('?')[0];
          // 取该图片父容器文字作为上下文
          var parent = img.closest('[class]');
          var context = parent ? (parent.textContent || '').trim().substring(0, 200) : '';
          results.push({
            id: id,
            scrollY: Math.round(scrollY),
            top: Math.round(rect.top),
            context: context.replace(/\s+/g, ' ')
          });
        }
      }
    });
  }
  return results;
})()
```

返回结果示例（部分）：
```json
[
  {"id": "1777327227CAZF.jpg-bigsize", "scrollY": 0, "top": 291, "context": "国家统计局公布了前三个月的工业增加值：仅看数据十分亮眼..."},
  {"id": "dYJHcOeUP2eL_20260428063334.png-bigsize", "scrollY": 8006, "top": 399, "context": "除原油和橡胶外，其他大宗商品大多都有少许回调..."}
]
```

**手工匹配规则**：根据 `context` 字段中的文字（图片周围可见的正文）判断每张图属于哪个 section：
- 统计局图片：context 含"工业增加值"、"营收利润率"
- 穆迪评级：context 含"穆迪"、"评级"
- PX/氟化工财报：context 含"一季报"、公司简称
- 大宗商品：context 含"大宗商品"、"原油"、"橡胶"
- 外围市场：context 含"美三大股指"、"纳指"

### Step 2b: 上传图片

滚动页面后，在 browser evaluate 中执行上传脚本（图片编号顺序与 DOM 遍历顺序一致）：

```javascript
(async function() {
  const GITHUB_TOKEN = 'ghp_REDACTED';
  const GITHUB_REPO = 'frankinvest/caijing-daily';
  const api = 'https://api.github.com/repos';
  const ghRaw = './';  // HTML 和图片同目录，相对路径

  function encodeBase64(arr) {
    var binary = '';
    var bytes = new Uint8Array(arr);
    for (var i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
    }
    return btoa(binary);
  }

  async function getFileSha(path) {
    var r = await fetch(api + '/' + GITHUB_REPO + '/contents/' + path + '?ref=main', {
      headers: {'Authorization': 'token ' + GITHUB_TOKEN}
    });
    if (r.ok) { var d = await r.json(); return d.sha; }
    return null;
  }

  async function uploadFile(filename, contentBase64) {
    var sha = await getFileSha(filename);
    var body = {message: 'Upload ' + filename, content: contentBase64, branch: 'main'};
    if (sha) body.sha = sha;
    var r = await fetch(api + '/' + GITHUB_REPO + '/contents/' + filename, {
      method: 'PUT',
      headers: {'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    return r.json();
  }

  // 从 DOM 提取所有 private.red-ring 图片 URL（顺序即编号顺序）
  var allImgUrls = [];
  document.querySelectorAll('img').forEach(function(img) {
    var src = img.src || '';
    if (src.includes('private.red-ring') && !src.includes('avatar')) allImgUrls.push(src);
  });

  var uploaded = {};
  for (var i = 0; i < allImgUrls.length; i++) {
    var url = allImgUrls[i];
    var ext = url.includes('.png') ? 'png' : 'jpg';
    var filename = 'caijing_YYYYMMDD_img_' + String(i+1).padStart(2,'0') + '.' + ext;
    try {
      var resp = await fetch(url);
      var buf = await resp.arrayBuffer();
      var b64 = encodeBase64(buf);
      var result = await uploadFile(filename, b64);
      if (result.content) {
        uploaded[url] = result.content.download_url;
        console.error('OK', i+1, filename);
      } else {
        console.error('FAIL', i+1, JSON.stringify(result).substring(0,100));
      }
    } catch(e) {
      console.error('ERR', i+1, e.message);
    }
  }

  return {total: allImgUrls.length, uploaded: Object.keys(uploaded).length};
})()
```

**注意**：上传后返回 `{total: N, uploaded: M}`。图片编号（01, 02, 03...）与 `querySelectorAll` 遍历顺序一致，图文对应关系由 Step 2a 的 `context` 手工判断。

### Step 3: 生成完整 HTML 并上传

构建含正文 + 图片 + 评论的完整 HTML，**直接嵌入正文内容**（不用 Markdown 外部引用），然后上传到 `caijing-daily` 仓库根目录。

HTML 模板结构：

```html
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>财经早餐 YYYYMMDD</title>
<style>
body{font-family:-apple-system;font-size:14px;max-width:720px;margin:0 auto;padding:16px;background:#fafafa;line-height:1.7;color:#333}
.post{background:white;border-radius:8px;padding:20px;margin-bottom:16px}
h2{font-size:1.05em;margin-top:1.5em;padding:6px 12px;background:#f0f4ff;border-left:3px solid #1a73e8}
p{margin:.5em 0}
strong{color:#c00}
.cmt{background:#fafafa;padding:12px;border-radius:8px;font-size:.9em}
.cmt-item{background:white;border-radius:6px;padding:12px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.u{color:#1a73e8;font-weight:600}
.t{color:#999;font-size:.8em;margin-left:8px}
.r{margin-top:6px;padding:6px 10px;background:#f5f5f5;border-radius:4px;font-size:.88em;color:#555}
</style>
</head>
<body>
<!-- 正文（含内嵌图片，用 ./caijing_YYYYMMDD_img_NN.{jpg|png} 替换 [图片N] 占位符）-->
<!-- 评论区块 -->
</body>
</html>
```

**内嵌图片替换规则**：
- `img_01`, `img_02`... 的 NN 编号 = 图片在 DOM 中的顺序（`querySelectorAll` 遍历顺序）
- 每张图的 `src` = `./caijing_YYYYMMDD_img_NN.{jpg|png}`（相对路径，与 HTML 同目录）
- 哪张图配哪个 section，根据 Step 2a 提取的 `context` 手工判断

上传 HTML（用 Python，不依赖浏览器）：

```python
# -*- coding: utf-8 -*-
import base64, json, urllib.request

TOKEN = 'ghp_REDACTED'
API = 'https://api.github.com/repos/frankinvest/caijing-daily/contents'
PATH = 'caijing_YYYYMMDD.html'  # 如 caijing_20260508.html

with open('/path/to/generated.html', 'rb') as f:
    content = f.read()

# 先获取已存在文件的 SHA（更新时必须传 sha）
def get_sha(path):
    req = urllib.request.Request(
        API + '/' + path + '?ref=main',
        headers={'Authorization': 'token ' + TOKEN}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()).get('sha')
    except:
        return None

b64 = base64.b64encode(content).decode('ascii')
sha = get_sha(PATH)
print('File SHA:', sha)

body = {
    'message': 'Update caijing_YYYYMMDD.html',
    'content': b64,
    'branch': 'main'
}
if sha:
    body['sha'] = sha  # 已存在文件必须传 sha，否则 422

body_enc = json.dumps(body).encode('utf-8')
req = urllib.request.Request(
    API + '/' + PATH,
    data=body_enc,
    headers={'Authorization': 'token ' + TOKEN, 'Content-Type': 'application/json'},
    method='PUT'
)
with urllib.request.urlopen(req, timeout=15) as r:
    d = json.loads(r.read())
    print('URL:', d.get('content', {}).get('download_url'))
```

**重要**：`sha` 字段规则：
- 文件**已存在**（更新）：必须传 `sha`，否则 422 "sha wasn't supplied"
- 文件**不存在**（新建）：不传 `sha`

### Step 4: 触发 GitHub Pages 构建

```bash
# 触发重建
curl -sL -X POST "https://api.github.com/repos/frankinvest/caijing-daily/pages/builds" \
  -H "Authorization: token ghp_REDACTED"

# 检查状态（等待 "built"）
curl -sL "https://api.github.com/repos/frankinvest/caijing-daily/pages" \
  -H "Authorization: token ghp_REDACTED"
```

公网访问：`https://frankinvest.github.io/caijing-daily/caijing_YYYYMMDD.html`

## 评论提取（browser evaluate）

获取页面所有评论和回复（包括闲聊点赞）。

**日期格式**：帖子内可能是 `今天 HH:MM` 或 `MM/DD HH:MM`（跨月切换时不同）。

```javascript
var allItems = document.querySelectorAll('.py-12');
var seen = {};
var comments = [];
for (var k = 0; k < allItems.length; k++) {
  var text = allItems[k].textContent || '';
  var tm = text.match(/(\d{2}:\d{2})/);
  if (!tm) continue;
  var time = tm[1];
  var idx = text.indexOf(time);
  var before = text.substring(0, idx - 1);
  var dm = before.match(/(\S{2,20})(\d{2}\/\d{2}|今天)\s*$/);
  if (!dm) continue;
  var user = dm[1].trim();
  var dateStr = dm[2];
  var key = user + ':' + dateStr + ' ' + time;
  if (seen[key]) continue;
  seen[key] = true;
  var body = text.substring(idx + time.length);
  var parts = body.split(/回复/);
  var mainContent = parts[0].trim().replace(/^[\n\r]*/,'').replace(/查看图片/g,'');
  var replies = parts.slice(1).map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
  comments.push({user: user, time: dateStr + ' ' + time, content: mainContent, replies: replies});
}
comments.sort(function(a, b) { return a.time.localeCompare(b.time); });
return comments;
```

## 格式规范

### HTML 正文字段结构
- 正文用 `<div class="post">` 包裹，含 `<h2>` 分节、`<p>` 段落
- 图片用 `<img src="...">` 直接嵌入，`src` 替换为 GitHub raw URL
- 红色强调用 `<strong>`（如 `strong{color:#c00}`）

### 评论 HTML 结构
```html
<div class="cmt">
  <h2>评论区</h2>
  <div class="cmt-item">
    <span class="u">用户名</span> <span class="t">时间</span>
    <p>评论内容</p>
    <div class="r"><strong>MR Dang：</strong> 回复内容<br><strong>其他人：</strong> 回复内容</div>
  </div>
</div>
```

## 注意事项

1. **图片命名**：`caijing_YYYYMMDD_img_NN.jpg`（NN 从 01 起，.png/.jpg 按实际扩展名）
2. **图片顺序**：按 `querySelectorAll` 遍历顺序编号，与 DOM 顺序一致
3. **图文对应（最关键）**：必须通过 Step 2a 的视口滚动脚本提取每张图的 `context`，根据上下文手工判断每张图属于哪个 section，**不能靠递归遍历、alt 属性或 className 判断**
4. **评论必须滚动**：页面评论是懒加载的，必须先滚动加载完再提取
5. **SHA 错误**：Python PUT 时已存在文件报 422，检查是否漏传 `sha` 字段
6. **GitHub Pages 404**：如果 Pages 访问 404，检查仓库 Settings → Pages → Source 是否为 main 分支
7. **公网链接格式**：`https://frankinvest.github.io/caijing-daily/caijing_YYYYMMDD.html`
8. **HTML 生成**：生成 HTML 时，`img` 标签的 `src` 用 GitHub raw URL 替换，`img_NN` 中的 NN 必须与图片在 DOM 中的顺序（`querySelectorAll` 遍历顺序）一一对应


---

## scripts/scrape_and_upload.js

```javascript

// -*- coding: utf-8 -*-
/**
 * red-ring-scraper: 图片提取 + 上传脚本
 * 在 browser evaluate 中运行，使用浏览器登录态抓取 private.red-ring.cn 图片并上传到 GitHub
 *
 * 用法：在小红圈帖子页面打开 DevTools Console，执行本脚本
 */

// ========== 配置 ==========
const GITHUB_TOKEN = 'ghp_REDACTED';
const GITHUB_REPO = 'frankinvest/caijing-daily';
const api = 'https://api.github.com/repos';
const ghRaw = 'https://raw.githubusercontent.com/frankinvest/caijing-daily/main';

// ========== 工具函数 ==========

/**
 * 将 ArrayBuffer 转为 base64 字符串（浏览器 safe）
 */
function arrayBufferToBase64(arr) {
  var binary = '';
  var bytes = new Uint8Array(arr);
  for (var i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.slice(i, i + 8192));
  }
  return btoa(binary);
}

/**
 * 从 GitHub 获取文件 SHA（用于更新已存在文件）
 */
async function getFileSha(filename) {
  var r = await fetch(api + '/' + GITHUB_REPO + '/contents/' + filename + '?ref=main', {
    headers: { 'Authorization': 'token ' + GITHUB_TOKEN }
  });
  if (r.ok) {
    var d = await r.json();
    return d.sha;
  }
  return null;
}

/**
 * 上传文件到 GitHub（自动判断 sha）
 */
async function uploadFile(filename, base64Content) {
  var sha = await getFileSha(filename);
  var body = {
    message: 'Upload ' + filename,
    content: base64Content,
    branch: 'main'
  };
  if (sha) body.sha = sha;

  var r = await fetch(api + '/' + GITHUB_REPO + '/contents/' + filename, {
    method: 'PUT',
    headers: {
      'Authorization': 'token ' + GITHUB_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return r.json();
}

// ========== 主逻辑 ==========

(async function() {
  // 1. 提取所有 private.red-ring 图片 URL（去重 + 排除 avatar）
  var allImgUrls = [];
  var seenUrls = {};
  document.querySelectorAll('img').forEach(function(img) {
    var src = img.src || '';
    if (src.includes('private.red-ring') && !src.includes('avatar') && !seenUrls[src]) {
      seenUrls[src] = true;
      allImgUrls.push(src);
    }
  });

  console.error('Found image URLs:', allImgUrls.length);

  // 2. 上传每张图片
  var uploaded = {};
  for (var i = 0; i < allImgUrls.length; i++) {
    var url = allImgUrls[i];
    var ext = url.includes('.png') ? 'png' : 'jpg';
    // 文件名格式：caijing_YYYYMMDD_img_NN.ext
    // TODO: 替换为实际日期
    var filename = 'caijing_YYYYMMDD_img_' + String(i + 1).padStart(2, '0') + '.' + ext;

    try {
      var resp = await fetch(url);
      if (!resp.ok) {
        console.error('FAIL fetch', i + 1, resp.status, url.substring(0, 60));
        continue;
      }
      var buf = await resp.arrayBuffer();
      var b64 = arrayBufferToBase64(buf);
      var result = await uploadFile(filename, b64);

      if (result.content) {
        uploaded[url] = result.content.download_url;
        console.error('OK', i + 1, filename, '->', result.content.download_url);
      } else {
        console.error('FAIL upload', i + 1, JSON.stringify(result).substring(0, 150));
      }
    } catch(e) {
      console.error('ERR', i + 1, e.message);
    }
  }

  // 3. 返回结果
  return {
    total: allImgUrls.length,
    uploaded: Object.keys(uploaded).length,
    map: uploaded
  };
})();

```
