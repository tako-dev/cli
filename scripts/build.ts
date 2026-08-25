#!/usr/bin/env bun
/**
 * 构建脚本 - 打包为 JS bundle
 */
import { mkdirSync, rmSync, writeFileSync } from "fs";

const pkg = await Bun.file("package.json").json();
const version = pkg.version;

console.log(`Building Tako CLI v${version}...`);

// Stub react-devtools-core（ink 的 optional devDependency，15MB，只在 dev 模式用）
// 创建空 stub 让 bundler resolve + inline，运行时 ink 的 try/catch 会静默跳过
const stubDir = "node_modules/react-devtools-core";
mkdirSync(stubDir, { recursive: true });
writeFileSync(`${stubDir}/index.js`, "export default {initialize(){},connectToDevTools(){}};");
writeFileSync(`${stubDir}/package.json`, '{"name":"react-devtools-core","version":"0.0.0","main":"index.js"}');

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  naming: "index.js",
  minify: true,
  target: "bun" as const,
  define: {
    "process.env.VERSION": JSON.stringify(version),
  },
});

if (result.success) {
  const file = result.outputs[0];
  const size = (file.size / 1024).toFixed(2);
  console.log(`  ✓ dist/index.js (${size} KB)`);

  // 确保有 shebang，这样 Unix 系统可以直接执行
  // Windows 不使用 shebang，有没有都不影响
  let content = await Bun.file("dist/index.js").text();
  if (!content.startsWith("#!/usr/bin/env bun")) {
    content = "#!/usr/bin/env bun\n" + content;
    await Bun.write("dist/index.js", content);
    console.log(`  ✓ 已添加 shebang`);
  }
} else {
  console.error("Build failed:");
  result.logs.forEach((log) => console.error(log));
  process.exit(1);
}
