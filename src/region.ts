import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { t } from "./i18n";
import { log } from "./logger";

type Region = "cn" | "global";

// 进程内缓存
let cachedRegion: Region | null = null;
// 进程内 in-flight 网络探测，避免并发重复请求
let inflightNetworkDetect: Promise<Region> | null = null;

// 文件缓存（持久化到 ~/.tako/region.json）
// 注意：此处不能 import "./config" 的 TAKO_DIR — 会引入循环依赖（config 不依赖 region，但保持单向）
const REGION_CACHE_PATH = join(homedir(), ".tako", "region.json");
const REGION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

// 镜像源配置
export const MIRRORS = {
  cn: {
    npm: "https://registry.npmmirror.com",
    bunBinary: "https://registry.npmmirror.com/-/binary/bun", // npmmirror 的 Bun 二进制镜像
    nodeBinary: "https://cdn.npmmirror.com/binaries/node",
  },
  global: {
    npm: "https://registry.npmjs.org",
    bunBinary: null,
    nodeBinary: "https://nodejs.org/dist",
  },
};

/**
 * 1) 环境变量手动覆盖（最高优先级，用户兜底逃生通道）
 */
function detectByEnvOverride(): Region | null {
  const v = process.env.TAKO_REGION?.trim().toLowerCase();
  if (v === "cn" || v === "china") return "cn";
  if (v === "global" || v === "intl" || v === "international") return "global";
  return null;
}

/**
 * 2) 读取文件缓存（同步，启动期零网络）
 */
function readCachedFromFile(): Region | null {
  try {
    const raw = readFileSync(REGION_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw) as { region?: Region; detectedAt?: number };
    if (data.region !== "cn" && data.region !== "global") return null;
    if (typeof data.detectedAt !== "number") return null;
    if (Date.now() - data.detectedAt > REGION_CACHE_TTL_MS) return null;
    return data.region;
  } catch {
    return null;
  }
}

function writeCacheToFile(region: Region): void {
  try {
    mkdirSync(join(homedir(), ".tako"), { recursive: true });
    writeFileSync(
      REGION_CACHE_PATH,
      JSON.stringify({ region, detectedAt: Date.now() }),
      "utf-8"
    );
  } catch {
    // 写缓存失败不影响功能
  }
}

/**
 * 3) 本地信号快路径（TZ / LANG），完全离线
 * 命中即可秒级返回，不发任何请求
 */
function detectByLocalSignals(): Region | null {
  // 时区：Asia/Shanghai、Asia/Urumqi、Asia/Chongqing、Asia/Harbin、Asia/Kashgar
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/^Asia\/(Shanghai|Urumqi|Chongqing|Harbin|Kashgar|Hong_Kong|Macau)$/i.test(tz)) {
      // 港澳走 global 源更稳，仅大陆时区判 cn
      if (/^Asia\/(Shanghai|Urumqi|Chongqing|Harbin|Kashgar)$/i.test(tz)) return "cn";
    }
  } catch {
    // 某些环境拿不到 Intl，忽略
  }

  // 语言：zh_CN.UTF-8 / zh-CN
  const lang = (process.env.LANG || process.env.LC_ALL || process.env.LC_MESSAGES || "").toLowerCase();
  if (lang.startsWith("zh_cn") || lang.startsWith("zh-cn")) return "cn";

  return null;
}

/**
 * 4) 网络探测：并发 + 1.2s 总超时，最快返回的赢
 * 全部失败 → 默认 "cn"（国内用户更多，保守）
 */
async function detectByNetwork(): Promise<Region> {
  if (inflightNetworkDetect) return inflightNetworkDetect;

  inflightNetworkDetect = (async () => {
    const NET_TIMEOUT = 1200;
    const tasks = [detectByIpApi, detectByIpInfo, detectByIpSb, detectByIpCn].map((fn) =>
      fn().then((r) => (r ? r : Promise.reject(new Error("null"))))
    );

    try {
      const winner = await Promise.race([
        Promise.any(tasks),
        new Promise<Region>((_, reject) =>
          setTimeout(() => reject(new Error("net-timeout")), NET_TIMEOUT)
        ),
      ]);
      return winner;
    } catch {
      return "cn";
    }
  })();

  return inflightNetworkDetect;
}

/**
 * 检测用户所在地区
 * 优先级：进程缓存 → 环境变量 → 文件缓存(30天) → 本地信号(TZ/LANG) → 网络探测
 * 前 4 步全部零网络，命中其一即可秒级返回。
 */
export async function detectRegion(): Promise<Region> {
  if (cachedRegion) return cachedRegion;

  // Step 1: 环境变量覆盖
  const envRegion = detectByEnvOverride();
  if (envRegion) {
    cachedRegion = envRegion;
    return envRegion;
  }

  // Step 2: 文件缓存
  const fileRegion = readCachedFromFile();
  if (fileRegion) {
    cachedRegion = fileRegion;
    return fileRegion;
  }

  // Step 3: 本地信号（不写缓存 —— 信号可能随用户环境变化，仅作为本次进程兜底）
  const localRegion = detectByLocalSignals();
  if (localRegion) {
    cachedRegion = localRegion;
    // 本地信号也写文件缓存：即便不准，也比每次启动都查 IP 强；30 天后会刷新
    writeCacheToFile(localRegion);
    return localRegion;
  }

  // Step 4: 网络探测（仅首次启动 / 缓存过期 / 无本地信号时才会到这）
  const netRegion = await detectByNetwork();
  cachedRegion = netRegion;
  writeCacheToFile(netRegion);
  return netRegion;
}

/**
 * 使用 ip-api.com 检测
 */
async function detectByIpApi(): Promise<"cn" | "global" | null> {
  try {
    const response = await fetch("https://ip-api.com/json/?fields=countryCode", {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    return data.countryCode === "CN" ? "cn" : "global";
  } catch {
    return null;
  }
}

/**
 * 使用 ipinfo.io 检测
 */
async function detectByIpInfo(): Promise<"cn" | "global" | null> {
  try {
    const response = await fetch("https://ipinfo.io/json", {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    return data.country === "CN" ? "cn" : "global";
  } catch {
    return null;
  }
}

/**
 * 使用 ip.sb 检测（备用）
 */
async function detectByIpSb(): Promise<"cn" | "global" | null> {
  try {
    const response = await fetch("https://api.ip.sb/geoip", {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;

    const data = await response.json();
    return data.country_code === "CN" ? "cn" : "global";
  } catch {
    return null;
  }
}

/**
 * 使用国内 API 检测（国内网络下响应最快）
 * 并发 3 个国内源竞速，任一返回即确认
 */
async function detectByIpCn(): Promise<"cn" | "global" | null> {
  const sources = [
    // ipip.net — 182ms，JSON 格式清晰
    async (): Promise<"cn" | "global" | null> => {
      const res = await fetch("https://myip.ipip.net/json", { signal: AbortSignal.timeout(800) });
      if (!res.ok) return null;
      const data = await res.json();
      const loc = data?.data?.location;
      if (Array.isArray(loc) && loc[0] === "中国") return "cn";
      const code = data?.data?.country_code;
      return code === "CN" ? "cn" : code ? "global" : null;
    },
    // pconline — 166ms，proCode 330000 = 浙江等大陆省份
    async (): Promise<"cn" | "global" | null> => {
      const res = await fetch("https://whois.pconline.com.cn/ipJson.jsp?json=true", { signal: AbortSignal.timeout(800) });
      if (!res.ok) return null;
      const text = await res.text();
      try {
        const data = JSON.parse(text.trim());
        // proCode 是 6 位数字（大陆省份编码），有值 = 国内
        if (data.proCode && /^\d{6}$/.test(data.proCode)) return "cn";
      } catch { /* 编码问题 parse 失败 */ }
      return null;
    },
    // ip.3322.net — 104ms，只返回 IP；能连通即证明国内（该域名海外几乎不通）
    async (): Promise<"cn" | "global" | null> => {
      const res = await fetch("http://ip.3322.net/api/", { signal: AbortSignal.timeout(600) });
      if (!res.ok) return null;
      const ip = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return "cn";
      return null;
    },
  ];

  try {
    return await Promise.any(sources.map((fn) => fn().then((r) => r ?? Promise.reject())));
  } catch { return null; }
}

/**
 * 获取当前地区的镜像源配置
 */
export async function getMirrors(): Promise<typeof MIRRORS.cn | typeof MIRRORS.global> {
  const region = await detectRegion();
  return MIRRORS[region];
}

/**
 * 获取 npm registry 地址
 */
export async function getNpmRegistry(): Promise<string> {
  const mirrors = await getMirrors();
  return mirrors.npm;
}

/**
 * 获取 Bun 安装命令（仅海外用户使用，国内用户走 installBunFromMirror）
 */
export function getBunInstallCommand(): string {
  return "curl -fsSL https://bun.sh/install | bash";
}

/**
 * 获取 npmmirror 上 Bun 的最新版本号
 */
export async function getLatestBunVersion(): Promise<string> {
  const mirror = MIRRORS.cn.bunBinary!;
  const response = await fetch(`${mirror}/`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Failed to fetch bun versions: ${response.status}`);

  const data = await response.json() as { name: string }[];
  const versions = data
    .map((item) => item.name.replace(/\/$/, "")) // 去掉尾部斜杠
    .filter((name) => /^bun-v\d+\.\d+\.\d+$/.test(name))
    .sort((a, b) => {
      const pa = a.replace("bun-v", "").split(".").map(Number);
      const pb = b.replace("bun-v", "").split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pb[i] - pa[i];
      }
      return 0;
    });

  if (versions.length === 0) throw new Error("No bun versions found on mirror");
  return versions[0]; // e.g. "bun-v1.3.9"
}

/**
 * 获取当前平台的 Bun 二进制下载 URL（npmmirror）
 */
export async function getBunMirrorDownloadUrl(): Promise<string> {
  const mirror = MIRRORS.cn.bunBinary!;
  const version = await getLatestBunVersion();

  const osMap: Record<string, string> = { darwin: "darwin", win32: "windows", linux: "linux" };
  const os = osMap[process.platform] || "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  const target = `bun-${os}-${arch}`;

  return `${mirror}/${version}/${target}.zip`;
}

/**
 * 显示当前使用的源
 */
export async function showRegionInfo(): Promise<void> {
  const region = await detectRegion();
  const mirrors = MIRRORS[region];

  if (region === "cn") {
    log.info(`${t("region.usingChinaMirror")} npm: ${mirrors.npm}`);
  } else {
    log.info(t("region.usingGlobalMirror"));
  }
}
