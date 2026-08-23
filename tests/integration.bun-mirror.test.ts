import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readdir, stat, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isWindows } from "./_helpers/paths";
import {
  MIRRORS,
  getLatestBunVersion,
  getBunMirrorDownloadUrl,
} from "../src/region";

// "重"集成用例需要真实从 npmmirror / bun.sh 下载二进制（30MB+），耗时 1-2 分钟且依赖外网。
// 默认 skip，CI / 本地需要时显式开启：TAKO_TEST_HEAVY=1 bun test
const RUN_HEAVY = process.env.TAKO_TEST_HEAVY === "1";
const itHeavy = RUN_HEAVY ? it : it.skip;

// Windows 远程测试配置
const WIN_HOST = "shiroha@172.17.66.6";
const WIN_SSH_OPTS = "-o StrictHostKeyChecking=no -o ConnectTimeout=5";

/**
 * 检查 Windows 远程机器是否可达
 */
async function isWindowsReachable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ssh", ...WIN_SSH_OPTS.split(" "), WIN_HOST, "echo ok"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    return proc.exitCode === 0 && out === "ok";
  } catch {
    return false;
  }
}

/**
 * 在远程 Windows 执行 PowerShell 脚本，返回 stdout
 */
async function runOnWindows(psScript: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // 把脚本写到临时文件传过去执行，避免 SSH 转义地狱
  const localTmp = join(tmpdir(), `win-test-${Date.now()}.ps1`);
  await Bun.write(localTmp, psScript);

  const remotePath = `C:\\Users\\SHIROHA\\tako-test-${Date.now()}.ps1`;

  // scp 上传
  const scp = Bun.spawn(["scp", ...WIN_SSH_OPTS.split(" "), localTmp, `${WIN_HOST}:${remotePath}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await scp.exited;

  // 执行
  const proc = Bun.spawn(
    ["ssh", ...WIN_SSH_OPTS.split(" "), WIN_HOST, `powershell -ExecutionPolicy Bypass -File "${remotePath}"`],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  // 清理远程和本地临时文件
  const cleanup = Bun.spawn(["ssh", ...WIN_SSH_OPTS.split(" "), WIN_HOST, `del "${remotePath}" 2>nul`], {
    stdout: "pipe", stderr: "pipe",
  });
  await cleanup.exited;
  await rm(localTmp, { force: true });

  return { exitCode: proc.exitCode ?? 1, stdout, stderr };
}

// ============================================================
// 1. region.ts 纯逻辑测试（不依赖网络、不依赖平台）
// ============================================================
describe("Bun Mirror - version parsing", () => {
  it("should parse and sort versions correctly (trailing slash)", () => {
    // 模拟 npmmirror API 返回的数据（name 带尾斜杠）
    const mockData = [
      { name: "bun-v0.8.1/" },
      { name: "bun-v1.3.9/" },
      { name: "bun-v1.2.0/" },
      { name: "bun-v1.3.10/" },
      { name: "canary/" },           // 应该被过滤
      { name: "bun-v0.0.19/" },
    ];

    const versions = mockData
      .map((item) => item.name.replace(/\/$/, ""))
      .filter((name) => /^bun-v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.replace("bun-v", "").split(".").map(Number);
        const pb = b.replace("bun-v", "").split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });

    expect(versions[0]).toBe("bun-v1.3.10");
    expect(versions[1]).toBe("bun-v1.3.9");
    expect(versions[2]).toBe("bun-v1.2.0");
    expect(versions).not.toContain("canary");
    expect(versions.length).toBe(5);
  });

  it("should generate correct download URL for each platform", () => {
    const mirror = MIRRORS.cn.bunBinary!;
    const version = "bun-v1.3.9";

    // macOS arm64
    expect(`${mirror}/${version}/bun-darwin-aarch64.zip`)
      .toBe("https://registry.npmmirror.com/-/binary/bun/bun-v1.3.9/bun-darwin-aarch64.zip");

    // macOS x64
    expect(`${mirror}/${version}/bun-darwin-x64.zip`)
      .toBe("https://registry.npmmirror.com/-/binary/bun/bun-v1.3.9/bun-darwin-x64.zip");

    // Linux x64
    expect(`${mirror}/${version}/bun-linux-x64.zip`)
      .toBe("https://registry.npmmirror.com/-/binary/bun/bun-v1.3.9/bun-linux-x64.zip");

    // Windows x64
    expect(`${mirror}/${version}/bun-windows-x64.zip`)
      .toBe("https://registry.npmmirror.com/-/binary/bun/bun-v1.3.9/bun-windows-x64.zip");
  });

  it("should have correct mirror config", () => {
    expect(MIRRORS.cn.npm).toBe("https://registry.npmmirror.com");
    expect(MIRRORS.cn.bunBinary).toBe("https://registry.npmmirror.com/-/binary/bun");
    expect(MIRRORS.cn.nodeBinary).toBe("https://cdn.npmmirror.com/binaries/node");
    expect(MIRRORS.global.npm).toBe("https://registry.npmjs.org");
    expect(MIRRORS.global.bunBinary).toBeNull();
    expect(MIRRORS.global.nodeBinary).toBe("https://nodejs.org/dist");
  });
});

// ============================================================
// 2. npmmirror API 测试（需要网络）
// ============================================================
describe("Bun Mirror - npmmirror API", () => {
  it("should fetch latest bun version from npmmirror", async () => {
    const version = await getLatestBunVersion();

    // 格式: bun-v1.3.9
    expect(version).toMatch(/^bun-v\d+\.\d+\.\d+$/);

    // 版本 >= 1.0.0
    const parts = version.replace("bun-v", "").split(".").map(Number);
    expect(parts[0]).toBeGreaterThanOrEqual(1);
  }, 15000);

  it("should generate valid download URL for current platform", async () => {
    const url = await getBunMirrorDownloadUrl();

    expect(url).toStartWith("https://registry.npmmirror.com/-/binary/bun/bun-v");
    expect(url).toEndWith(".zip");

    // 应该包含当前平台
    if (process.platform === "darwin") {
      expect(url).toContain("darwin");
    } else if (process.platform === "win32") {
      expect(url).toContain("windows");
    } else {
      expect(url).toContain("linux");
    }
  }, 15000);

  it("should have downloadable binary at the URL", async () => {
    const url = await getBunMirrorDownloadUrl();

    // HEAD 请求验证 URL 可访问
    const response = await fetch(url, { method: "HEAD" });
    expect(response.ok).toBe(true);

    // 文件大小应 > 10MB
    const contentLength = Number(response.headers.get("content-length") || 0);
    expect(contentLength).toBeGreaterThan(10 * 1024 * 1024);
  }, 30000);
});

// ============================================================
// 3. macOS 本机真实安装测试（国内镜像）
// ============================================================
describe("Bun Mirror - macOS CN install", () => {
  if (isWindows()) {
    it.skip("skipped on Windows", () => {});
    return;
  }

  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tako-bun-test-macos-cn-"));
  });

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  itHeavy("should download and install bun from npmmirror", async () => {
    const mirror = MIRRORS.cn.bunBinary!;
    const version = await getLatestBunVersion();
    const arch = process.arch === "arm64" ? "aarch64" : "x64";
    const target = `bun-darwin-${arch}`;
    const url = `${mirror}/${version}/${target}.zip`;
    const zipPath = join(tempDir, "bun.zip");

    // 用 curl 下载（和 install.sh 一致）
    const dl = Bun.spawn(
      ["curl", "--fail", "--location", "--output", zipPath, url],
      { stdout: "pipe", stderr: "pipe" },
    );
    await dl.exited;
    expect(dl.exitCode).toBe(0);

    // 验证 zip 文件大小合理
    const zipStat = await stat(zipPath);
    expect(zipStat.size).toBeGreaterThan(10 * 1024 * 1024);

    // 解压
    const proc = Bun.spawn(["unzip", "-oq", zipPath, "-d", tempDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // 移动到 bin/
    const binDir = join(tempDir, "bin");
    const { mkdir: mkdirFs, rename, chmod } = await import("fs/promises");
    await mkdirFs(binDir, { recursive: true });
    await rename(join(tempDir, target, "bun"), join(binDir, "bun"));
    await chmod(join(binDir, "bun"), 0o755);

    // 验证可执行
    const bunProc = Bun.spawn([join(binDir, "bun"), "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await bunProc.exited;
    expect(bunProc.exitCode).toBe(0);

    const bunVersion = (await new Response(bunProc.stdout).text()).trim();
    expect(bunVersion).toMatch(/^\d+\.\d+\.\d+$/);

    // 版本应和 npmmirror 返回的一致
    expect(`bun-v${bunVersion}`).toBe(version);
  }, 120000);
});

// ============================================================
// 4. macOS 本机真实安装测试（海外官方源）
// ============================================================
describe("Bun Mirror - macOS global install", () => {
  if (isWindows()) {
    it.skip("skipped on Windows", () => {});
    return;
  }

  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "tako-bun-test-macos-global-"));
  });

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  itHeavy("should install bun via official script (bun.sh)", async () => {
    const proc = Bun.spawn(
      ["bash", "-c", `export BUN_INSTALL="${tempDir}" && curl -fsSL https://bun.sh/install | bash`],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    expect(proc.exitCode).toBe(0);

    // 验证可执行
    const bunBin = join(tempDir, "bin", "bun");
    await access(bunBin);

    const versionProc = Bun.spawn([bunBin, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await versionProc.exited;
    expect(versionProc.exitCode).toBe(0);

    const version = (await new Response(versionProc.stdout).text()).trim();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  }, 120000);
});

// ============================================================
// 5. Windows 远程真实安装测试（国内镜像）
// ============================================================
describe("Bun Mirror - Windows CN install", () => {
  let winReachable = false;

  beforeAll(async () => {
    winReachable = await isWindowsReachable();
    if (!winReachable) {
      console.warn("  [SKIP] Windows remote machine not reachable");
    }
  }, 30000);

  it("should download and install bun from npmmirror on Windows", async () => {
    if (!winReachable) return;

    const { exitCode, stdout, stderr } = await runOnWindows(`
$ErrorActionPreference = "Stop"
$testDir = "$env:TEMP\\tako-bun-test-cn-$(Get-Random)"
New-Item -ItemType Directory -Path $testDir -Force | Out-Null

try {
    # Fetch latest version
    $mirror = "https://registry.npmmirror.com/-/binary/bun"
    $resp = Invoke-RestMethod -Uri "$mirror/" -TimeoutSec 15

    $versions = @()
    foreach ($item in $resp) {
        if ($item.name -match '^bun-v(\\d+)\\.(\\d+)\\.(\\d+)/') {
            $versions += [PSCustomObject]@{
                Name = $item.name -replace '/$',''
                Sort = [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]
            }
        }
    }
    $latest = ($versions | Sort-Object Sort -Descending | Select-Object -First 1).Name
    Write-Output "VERSION=$latest"

    # Download
    $url = "$mirror/$latest/bun-windows-x64.zip"
    $zipFile = "$testDir\\bun.zip"
    Invoke-WebRequest -Uri $url -OutFile $zipFile -UseBasicParsing
    $size = (Get-Item $zipFile).Length
    Write-Output "SIZE=$size"

    # Extract
    Expand-Archive -Path $zipFile -DestinationPath $testDir -Force
    $bunExe = Get-ChildItem -Path $testDir -Recurse -Filter "bun.exe" | Select-Object -First 1

    if (-not $bunExe) {
        Write-Output "RESULT=FAIL_NO_EXE"
        exit 1
    }

    # Verify
    $ver = & $bunExe.FullName --version 2>&1
    Write-Output "BUN_VERSION=$ver"
    Write-Output "RESULT=OK"
} finally {
    Remove-Item -Recurse -Force $testDir -ErrorAction SilentlyContinue
}
`);

    // 解析输出
    const lines = stdout.split("\n").map((l) => l.trim());
    const get = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.split("=")[1] || "";

    expect(get("RESULT")).toBe("OK");
    expect(get("VERSION")).toMatch(/^bun-v\d+\.\d+\.\d+$/);
    expect(Number(get("SIZE"))).toBeGreaterThan(10 * 1024 * 1024);
    expect(get("BUN_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);

    // 版本一致性
    expect(`bun-v${get("BUN_VERSION")}`).toBe(get("VERSION"));
  }, 120000);
});

// ============================================================
// 6. Windows 远程真实安装测试（海外官方源）
// ============================================================
describe("Bun Mirror - Windows global install", () => {
  let winReachable = false;

  beforeAll(async () => {
    winReachable = await isWindowsReachable();
    if (!winReachable) {
      console.warn("  [SKIP] Windows remote machine not reachable");
    }
  }, 30000);

  it("should install bun via official PowerShell script (bun.sh)", async () => {
    if (!winReachable) return;

    const { exitCode, stdout, stderr } = await runOnWindows(`
$ErrorActionPreference = "Stop"
$testDir = "$env:TEMP\\tako-bun-test-global-$(Get-Random)"
New-Item -ItemType Directory -Path $testDir -Force | Out-Null

try {
    $env:BUN_INSTALL = $testDir
    irm bun.sh/install.ps1 | iex

    $bunExe = Get-ChildItem -Path $testDir -Recurse -Filter "bun.exe" | Select-Object -First 1
    if (-not $bunExe) {
        Write-Output "RESULT=FAIL_NO_EXE"
        exit 1
    }

    $ver = & $bunExe.FullName --version 2>&1
    Write-Output "BUN_VERSION=$ver"
    Write-Output "RESULT=OK"
} finally {
    $env:BUN_INSTALL = ""
    Remove-Item -Recurse -Force $testDir -ErrorAction SilentlyContinue
}
`);

    const lines = stdout.split("\n").map((l) => l.trim());
    const get = (key: string) => lines.find((l) => l.startsWith(`${key}=`))?.split("=")[1] || "";

    expect(get("RESULT")).toBe("OK");
    expect(get("BUN_VERSION")).toMatch(/^\d+\.\d+\.\d+$/);
  }, 180000);
});

// ============================================================
// 7. install.sh 脚本测试（本机 bash）
// ============================================================
describe("Bun Mirror - install.sh script", () => {
  if (isWindows()) {
    it.skip("skipped on Windows", () => {});
    return;
  }

  const scriptPath = join(import.meta.dir, "..", "install.sh");

  itHeavy("should detect region and install bun (cn mode)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tako-installsh-cn-"));
    const takoDir = join(tempDir, ".tako");
    const bunDir = join(takoDir, "bun");

    try {
      // 只运行 detect_region + install_bun，跳过 Tako CLI 安装
      const testScript = `
        export HOME="${tempDir}"
        export TAKO_DIR="${takoDir}"
        export TAKO_BUN_DIR="${bunDir}"
        source "${scriptPath}"
        REGION="cn"
        install_bun
        echo "EXIT_CODE=$?"
        "${bunDir}/bin/bun" --version
      `;

      const proc = Bun.spawn(["bash", "-c", testScript], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.trim().split("\n");

      // 最后一行应该是版本号
      const lastLine = lines[lines.length - 1].trim();
      expect(lastLine).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60000);

  itHeavy("should detect region and install bun (global mode)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "tako-installsh-global-"));
    const takoDir = join(tempDir, ".tako");
    const bunDir = join(takoDir, "bun");

    try {
      const testScript = `
        export HOME="${tempDir}"
        export TAKO_DIR="${takoDir}"
        export TAKO_BUN_DIR="${bunDir}"
        source "${scriptPath}"
        REGION="global"
        install_bun
        echo "EXIT_CODE=$?"
        "${bunDir}/bin/bun" --version
      `;

      const proc = Bun.spawn(["bash", "-c", testScript], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;

      const stdout = await new Response(proc.stdout).text();
      const lines = stdout.trim().split("\n");
      const lastLine = lines[lines.length - 1].trim();
      expect(lastLine).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120000);

  it("should default to cn when region detection fails", async () => {
    // 模拟所有 IP 检测服务不可达
    const testScript = `
      source "${scriptPath}"
      # 覆盖 curl 使其返回空
      curl() { echo ""; return 1; }
      export -f curl
      detect_region
      echo "REGION=$REGION"
    `;

    const proc = Bun.spawn(["bash", "-c", testScript], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const stdout = await new Response(proc.stdout).text();
    expect(stdout).toContain("REGION=cn");
  }, 15000);
});
