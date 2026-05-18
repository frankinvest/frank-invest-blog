import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import https from "https";

// GitHub 配置
const GITHUB_CONFIG = {
  token: process.env.GITHUB_TOKEN || "",
  owner: "frankinvest",
  repo: "frank-invest-blog",
  branch: "main",
  path: "source/images",
};

// Chrome 用户数据目录（用于共享登录状态）
const CHROME_USER_DATA_DIR = "/Users/frank_bot/Library/Application Support/Google/Chrome";

// Cookie 目录
const COOKIE_DIR = path.join(process.env.HOME!, ".openclaw/workspace/cookies");

// 媒体目录
const MEDIA_DIR = path.join(process.env.HOME!, ".openclaw/media/browser");

// 确保目录存在
[COOKIE_DIR, MEDIA_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const server = new McpServer({
  name: "ScreenshotToURL",
  version: "1.0.0",
});

/**
 * 获取 Cookie 文件路径
 */
function getCookiePath(domain: string): string {
  const safeName = domain.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(COOKIE_DIR, `${safeName}_cookies.json`);
}

/**
 * 加载 Cookie
 */
function loadCookies(domain: string): any[] | null {
  const cookiePath = getCookiePath(domain);
  if (fs.existsSync(cookiePath)) {
    try {
      const data = fs.readFileSync(cookiePath, "utf-8");
      return JSON.parse(data);
    } catch (e) {
      console.error(`[ScreenshotToURL] 加载 Cookie 失败:`, e);
    }
  }
  return null;
}

/**
 * 保存 Cookie
 */
function saveCookiesToFile(domain: string, cookies: any[]): void {
  const cookiePath = getCookiePath(domain);
  try {
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    console.error(`[ScreenshotToURL] Cookie 已保存: ${cookiePath} (${cookies.length} 条)`);
  } catch (e) {
    console.error(`[ScreenshotToURL] 保存 Cookie 失败:`, e);
  }
}

/**
 * 从 URL 提取域名
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * 上传文件到 GitHub
 */
async function uploadToGitHub(
  localPath: string,
  filename: string
): Promise<{ rawUrl: string; pageUrl: string } | null> {
  if (!GITHUB_CONFIG.token) {
    console.error("[ScreenshotToURL] 未配置 GITHUB_TOKEN");
    return null;
  }

  try {
    const fileContent = fs.readFileSync(localPath);
    const base64Content = fileContent.toString("base64");
    const apiUrl = `https://api.github.com/repos/${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.path}/${filename}`;

    let sha: string | undefined;
    try {
      const checkResponse = await githubApi("GET", apiUrl, null, GITHUB_CONFIG.token);
      if (checkResponse && checkResponse.sha) sha = checkResponse.sha;
    } catch (e) {}

    const body: any = {
      message: `Upload screenshot: ${filename}`,
      content: base64Content,
      branch: GITHUB_CONFIG.branch,
    };
    if (sha) body.sha = sha;

    const response = await githubApi("PUT", apiUrl, body, GITHUB_CONFIG.token);
    if (response && response.content && response.content.download_url) {
      const rawUrl = response.content.download_url;
      const pageUrl = rawUrl
        .replace("raw.githubusercontent.com", "github.com")
        .replace("/main/", "/blob/main/");
      console.error(`[ScreenshotToURL] GitHub 上传成功: ${rawUrl}`);
      return { rawUrl, pageUrl };
    }
    return null;
  } catch (error) {
    console.error(`[ScreenshotToURL] GitHub 上传失败:`, error);
    return null;
  }
}

/**
 * GitHub API 请求
 */
function githubApi(
  method: string,
  url: string,
  body: any,
  token: string
): Promise<any> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options: any = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "ScreenshotToURL-MCP/1.0",
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`JSON parse failed: ${data}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 网页截图工具 - 优先使用 Chrome 配置文件
 */
server.tool(
  "capture_page",
  "截取指定网页的完整页面截图，支持登录状态",
  {
    url: z.string().url().describe("需要截图的网页地址（必须包含 http:// 或 https://）"),
    filename: z.string().describe("保存的文件名（建议使用 .png 后缀）"),
    fullPage: z.boolean().optional().default(true).describe("是否截取完整页面，默认为 true"),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("networkidle").describe("等待页面加载完成的策略"),
    upload: z.boolean().optional().default(true).describe("是否上传到 GitHub 并返回公网链接，默认为 true"),
    saveCookies: z.boolean().optional().default(false).describe("是否保存当前页面的 Cookie 到本地（用于登录状态持久化）"),
  },
  async ({ url, filename, fullPage, waitUntil, upload, saveCookies }): Promise<{
    content: Array<{ type: "text"; text: string }>;
  }> => {
    let browser: any = null;

    try {
      const safeFilename = filename.endsWith(".png") ? filename : `${filename}.png`;
      const storagePath = path.join(MEDIA_DIR, safeFilename);
      const domain = getDomain(url);

      console.error(`[ScreenshotToURL] 启动浏览器...`);

      // 尝试使用 Chrome 用户数据目录
      let context;
      try {
        browser = await chromium.launch({
          headless: true,
          channel: "chrome",
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        context = await browser.newContext();
      } catch (e) {
        // Chrome channel 失败，使用默认 launch
        console.error(`[ScreenshotToURL] Chrome 配置文件不可用，使用默认浏览器`);
        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });
        context = await browser.newContext();
      }

      const page = await context.newPage();

      // 加载保存的 Cookie（如果存在）
      const savedCookies = loadCookies(domain);
      if (savedCookies && savedCookies.length > 0) {
        console.error(`[ScreenshotToURL] 加载 Cookie: ${domain} (${savedCookies.length} 条)`);
        try {
          await context.addCookies(savedCookies);
        } catch (e) {
          console.error(`[ScreenshotToURL] 设置 Cookie 失败:`, e);
        }
      }

      // 设置视口
      await page.setViewportSize({ width: 1920, height: 1080 });

      console.error(`[ScreenshotToURL] 访问页面: ${url}`);
      await page.goto(url, {
        waitUntil: waitUntil as "networkidle" | "load" | "domcontentloaded" | "commit",
        timeout: 30000,
      });

      // 等待额外加载
      await page.waitForTimeout(2000);

      // 如果需要保存 Cookie
      if (saveCookies) {
        try {
          const cookies = await context.cookies(url);
          if (cookies && cookies.length > 0) {
            saveCookiesToFile(domain, cookies);
          }
        } catch (e) {
          console.error(`[ScreenshotToURL] 获取 Cookie 失败:`, e);
        }
      }

      console.error(`[ScreenshotToURL] 截图保存至: ${storagePath}`);
      await page.screenshot({
        path: storagePath,
        fullPage: fullPage ?? true,
      });

      await browser.close();

      // 上传到 GitHub
      let githubResult: { rawUrl: string; pageUrl: string } | null = null;
      if (upload && GITHUB_CONFIG.token) {
        console.error(`[ScreenshotToURL] 上传到 GitHub...`);
        githubResult = await uploadToGitHub(storagePath, safeFilename);
      }

      const localUrl = `http://127.0.0.1:18790/media/browser/${safeFilename}`;

      let message = `✅ 截图成功！\n\n📁 文件名：${safeFilename}\n📂 本地路径：${storagePath}`;

      if (githubResult) {
        message += `\n\n🌐 公网访问链接：\n${githubResult.rawUrl}`;
      } else if (upload) {
        message += `\n\n⚠️ GitHub 上传未配置或失败`;
      }

      if (saveCookies) {
        message += `\n\n🍪 Cookie 已保存用于 ${domain}`;
      }

      message += `\n\n🔗 本地访问：${localUrl}`;

      return { content: [{ type: "text", text: message }] };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ScreenshotToURL] 错误: ${errorMessage}`);

      if (browser) await browser.close().catch(() => {});

      return {
        content: [{
          type: "text",
          text: `❌ 截图失败\n\n错误信息：${errorMessage}\n\n请检查：\n1. URL 是否正确且可访问\n2. 网络连接是否正常\n3. 目标网站是否允许被爬取`,
        }],
      };
    }
  }
);

// 启动服务器
const transport = new StdioServerTransport();
server.connect(transport).catch((error) => {
  console.error("[ScreenshotToURL] 服务器连接失败:", error);
  process.exit(1);
});
