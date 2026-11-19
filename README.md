# AETHER · 全球电波地图

在三维地球上探索并收听来自世界各地的电台。纯前端实现，无需构建、无需后端，桌面 Web 与移动端 H5 自适应。

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](#)
[![No Build](https://img.shields.io/badge/build-none-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

## 功能特性

- **3D 地球**：可拖拽旋转、滚轮/双指缩放、空闲自动旋转。电台以贴地光点呈现，按热度做暗铜到亮金的颜色渐变，当前播放台显示脉冲环。
- **2D 兼容地图**：检测到浏览器无 WebGL（硬件加速关闭、远程桌面、旧显卡等）时自动降级为 Canvas 绘制的等距圆柱投影世界地图，功能与 3D 一致。右上角可手动切换 3D / 2D。
- **电台列表**：网格列表，支持按投票数、收听数、名称、码率排序，并可分批从全球目录继续加载。
- **国家筛选**：列表头部按国家下拉筛选，选项由已加载电台动态聚合，附带国旗与电台数量，可按数量或名称排序。
- **搜索与筛选**：输入即过滤（名称、国家、地区、语言、风格标签），并通过 API 扩展搜索结果；顶部提供热门风格快捷筛选，所有筛选条件可叠加使用。
- **收藏**：一键收藏，写入 `localStorage` 持久化，支持「只看收藏」模式。
- **播放器**：播放/暂停、上一台/下一台、音量记忆、加载与断流提示。
- **格式自适应**：用 `audio.canPlayType()` 探测本机浏览器对 MP3 / AAC / OGG / Opus / FLAC 的支持，加载时自动剔除无法解码的电台。
- **离线兜底**：内置 620 座真实电台（覆盖 112 国，HTTPS 流 + 地理坐标），网络或策略受限时仍可完整浏览与收听。

## 快速开始

地图纹理通过相对路径加载，需通过 HTTP 服务访问（直接双击 `index.html` 可能因浏览器限制导致纹理或 API 请求失败）。

```bash
git clone https://github.com/<your-name>/<your-repo>.git
cd <your-repo>

# 方式一：Python 内置服务器
python3 -m http.server 8765

# 方式二：Node
npm start
```

然后访问 <http://localhost:8765>。

## 技术栈

| 层次 | 实现 |
| --- | --- |
| 界面 | 原生 HTML / CSS，无框架、无构建步骤 |
| 3D 地球 | [globe.gl](https://github.com/vasturiano/globe.gl) 2.41.4（Three.js），本地化于 `vendor/` |
| 2D 备用地图 | 原生 Canvas 2D，自绘 Natural Earth 110m 陆地轮廓 |
| 数据 | [Radio Browser](https://www.radio-browser.info/) 公共 API，无需密钥 |
| 持久化 | `localStorage`（收藏、音量） |

设计上采用「声学地图集」方向：暖白纸面色板、深墨蓝文字、琥珀强调色，Fraunces 衬线标题搭配 DM Sans 正文，叠加经纬网格纹理。全部正文配色满足 WCAG AA 对比度。

## 数据源说明

应用通过 Radio Browser 的公开镜像获取电台目录：

```
https://de1.api.radio-browser.info/json/stations/search
  ?hidebroken=true&has_geo_info=true&order=votes&reverse=true&limit=600
```

- 多个镜像顺序回退，任一可用即可。
- `has_geo_info=true` 保证结果带经纬度，可在地图上定位。
- 目录总量约 4 万座在线电台，其中约 1 万座带坐标。
- 请求失败时自动使用 `js/builtin-stations.js` 中的内置目录，并在状态栏提供「重试连接」。

## 目录结构

```
.
├── index.html                # 页面结构
├── css/
│   └── style.css             # 设计令牌、布局、响应式
├── js/
│   ├── app.js                # 状态管理、数据加载、播放器、视图切换
│   ├── flat-map.js           # 2D 兼容地图（Canvas）
│   ├── world-geo.js          # 世界陆地轮廓数据
│   ├── builtin-stations.js   # 内置 620 座电台目录
│   └── fallback.js           # 最小回退数据集
├── vendor/
│   └── globe.gl.min.js       # 3D 地球库
├── assets/
│   ├── earth-blue-marble.jpg # 地球贴图
│   ├── earth-topology.png    # 地形凹凸贴图
│   └── favicon.svg
└── package.json
```

## 部署

任意静态托管均可，无需服务端。以 GitHub Pages 为例：

1. 将仓库推送到 GitHub。
2. 进入 **Settings → Pages**。
3. Source 选择 **Deploy from a branch**，分支 `main`、目录 `/ (root)`。
4. 保存后访问 `https://<user>.github.io/<repo>/`。

也可直接部署到 Vercel、Netlify 或 Cloudflare Pages，构建命令留空、输出目录填 `.`。

## 已知限制

- **HTTPS 与 HTTP 流**：浏览器禁止 HTTPS 页面加载 HTTP 音频流。部署在 HTTPS 时会自动过滤这类电台，可用数量约为全部的三分之二。本地 `http://localhost` 不受影响。
- **预览面板的 CSP**：部分 IDE 或文档预览器会注入 `Content-Security-Policy`，拦截对外部 API 的请求。此时应用会启用内置目录并提示，完整体验请在真实浏览器中打开。
- **公共流稳定性**：Radio Browser 的「最后检查正常」标记存在滞后，抽样约 70% 的流可即时连通。换台即可，不影响应用本身。
- **无坐标电台**：约 3 万座电台未提供经纬度，无法显示在地图上，只能通过搜索命中后收听。

## 许可

[MIT](LICENSE)
