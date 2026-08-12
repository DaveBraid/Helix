import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const releaseCapabilities = await readFile("src/release-capabilities.ts", "utf8");

const requiredArtifacts = [
  "manifest.json",
  "main.js",
  "styles.css",
  "THIRD_PARTY_NOTICES.md",
  "licenses/ECHARTS_LICENSE.txt",
  "licenses/ECHARTS_NOTICE.txt",
  "licenses/ZRENDER_LICENSE.txt",
  "licenses/D3_LICENSE.txt",
];
await Promise.all(requiredArtifacts.map((file) => access(file)));

const [echartsLicense, echartsNotice, zrenderLicense, d3License] =
  await Promise.all(requiredArtifacts.slice(4).map((file) => readFile(file, "utf8")));
if (!echartsLicense.includes("END OF TERMS AND CONDITIONS")) {
  throw new Error("ECharts Apache 2.0 完整许可证缺失");
}
if (!echartsNotice.includes("The Apache Software Foundation")) {
  throw new Error("ECharts NOTICE 缺失");
}
if (!zrenderLicense.includes("BSD 3-Clause License") ||
    !zrenderLicense.includes("THIS SOFTWARE IS PROVIDED")) {
  throw new Error("ZRender BSD 3-Clause 完整许可证缺失");
}
if (!d3License.includes("Copyright 2010-2016 Mike Bostock") ||
    !d3License.includes("THIS SOFTWARE IS PROVIDED")) {
  throw new Error("ECharts d3 子组件许可证缺失");
}

if (manifest.version !== packageJson.version) {
  throw new Error("manifest.json 与 package.json 的版本不一致");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json 未登记当前版本与最低 Obsidian 版本");
}
if (!manifest.isDesktopOnly) {
  throw new Error("当前桌面阶段必须保持 isDesktopOnly=true");
}
if (!releaseCapabilities.includes("export const DIDA_READ_AVAILABLE = true")) {
  throw new Error("当前开发基线必须开放滴答只读门禁");
}
if (!releaseCapabilities.includes("export const DIDA_CONTRACT_TEST_AVAILABLE = true")) {
  throw new Error("当前合同验证基线必须开放专用合同门禁");
}
if (!releaseCapabilities.includes("export const DIDA_TASK_WRITE_AVAILABLE = true")) {
  throw new Error("当前开发基线必须开放滴答普通任务写入门禁");
}
for (const capability of ["PROJECT_DIDA_PROJECTION_AVAILABLE"]) {
  if (!releaseCapabilities.includes(`export const ${capability} = false`)) {
    throw new Error(`当前本地正式版必须关闭 ${capability} 门禁`);
  }
}

console.log(`Helix ${manifest.version} 发布产物检查通过：${requiredArtifacts.join("、")}`);
