# AETHER · 全球电波地图

在三维地球上探索并收听来自世界各地的电台。纯前端实现，无需构建，桌面 Web 与移动端 H5 自适应。收藏与设置由内置的极简本地服务（`server.py`，仅标准库）落到磁盘，本机任意浏览器打开都是同一份数据。

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](#)
[![No Build](https://img.shields.io/badge/build-none-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

## 功能特性

- **3D 地球**：可拖拽旋转、滚轮/双指缩放、空闲自动旋转。电台以贴地光点呈现，按热度做暗铜到亮金的颜色渐变，当前播放台显示脉冲环。
- **坐标补全与置信度**：目录原始只有约 1.1 万座带坐标；构建时用 GeoNames 地名数据把其余电台补到 97.8% 可定位，并按可信度标记来源（`original` / `city` / `admin1` / `country`）。推算点在地球与 2D 地图上更小、更灰，详情与悬浮提示会注明「位置估算」；右上角「估算位置」开关可一键隐藏推算点，只看真实坐标。真实坐标与推算坐标在统计中分开计数。
- **全量目录**：列表加载全部电台（含无坐标），滚动到底自动继续拉取；状态栏实时显示「已载入 X / 目录 52,981」。
- **3D / 2D / 卫星三种地图**：右上角可切换。3D 为 globe.gl 地球；2D 为无 WebGL 时自动降级的 Canvas 世界地图；**卫星模式用 MapLibre 5.x globe 投影 + Esri World Imagery 免费卫星瓦片（与 radio.garden 同款做法），可一路放大到城市街道级**，电台光点覆盖在卫星影像上，点击即可收听。三种模式共用同一份电台数据与详情/播放状态。
- **电台列表**：网格列表，支持按投票数、收听数、名称、码率排序，并可分批从全球目录继续加载。
- **国家筛选**：列表头部按国家下拉筛选，选项由已加载电台动态聚合，附带国旗与中文国名及数量；切换筛选时会向目录补全对应国家的电台，而非只筛本地已载入的部分。
- **搜索与筛选**：输入即过滤（名称、国家、地区、语言、风格标签），并同时以「电台名」和「风格标签」两种方式向目录检索，因此 `jazz`、`reggae` 这类流派词也能命中；顶部提供热门风格快捷筛选，所有筛选条件可叠加使用。
- **收藏**：一键收藏，支持「只看收藏」模式。默认由本地服务写入 `.data/state.json`，换浏览器也能读到同一份收藏；没有该接口时自动退回 `localStorage`。
- **播放器**：播放/暂停、上一台/下一台、音量记忆、加载与断流提示。
- **格式自适应**：用 `audio.canPlayType()` 探测本机浏览器对 MP3 / AAC / OGG / Opus / FLAC 的支持，加载时自动剔除无法解码的电台。
- **离线兜底**：内置 620 座真实电台（覆盖 112 国，HTTPS 流 + 地理坐标），网络或策略受限时仍可完整浏览与收听。

## 快速开始

地图纹理通过相对路径加载，需通过 HTTP 服务访问（直接双击 `index.html` 可能因浏览器限制导致纹理或 API 请求失败）。

```bash
git clone https://github.com/<your-name>/<your-repo>.git
cd <your-repo>

# 推荐：带共享状态存储的本地服务（收藏/设置跨浏览器一致）
python3 server.py            # 等价于 npm start

# 纯静态：也能跑，但收藏只存在当前浏览器的 localStorage 里
python3 -m http.server 8765
```

然后访问 <http://localhost:8765>。

### 收藏与设置的存储位置

`server.py` 提供两个接口，数据落在项目根目录的 `.data/state.json`（已加入 `.gitignore`）：

| 接口 | 作用 |
| --- | --- |
| `GET /api/state` | 读取收藏、音量、排序、上次收听的电台 |
| `PUT /api/state` | 整体写入，先写临时文件再原子替换，避免半截 JSON |

前端启动时先读一次 `/api/state`；如果读不到（纯静态托管、`file://` 打开或部署到 GitHub Pages），就退回 `localStorage`，功能不受影响。多开浏览器时会话切回前台会自动比对 `updatedAt` 再同步一次。

## 技术栈

| 层次 | 实现 |
| --- | --- |
| 界面 | 原生 HTML / CSS，无框架、无构建步骤 |
| 3D 地球 | [globe.gl](https://github.com/vasturiano/globe.gl) 2.41.4（Three.js），本地化于 `vendor/` |
| 2D 备用地图 | 原生 Canvas 2D，自绘 Natural Earth 110m 陆地轮廓 |
| 卫星地球 | [MapLibre GL JS](https://maplibre.org/) 5.23.0（globe 投影）+ Esri World Imagery 卫星瓦片，均本地化于 `vendor/`；瓦片运行时从 Esri 拉取、无需 API key |
| 数据 | [Radio Browser](https://www.radio-browser.info/) 公共目录 + GeoNames 地名数据，离线封装于 `data/` |
| 持久化 | 本地服务落盘 + `localStorage` 回退 |

设计上采用「声学地图集」方向：暖白纸面色板、深墨蓝文字、琥珀强调色，Fraunces 衬线标题搭配 DM Sans 正文，叠加经纬网格纹理。全部正文配色满足 WCAG AA 对比度。

## 数据源说明

### 本地目录（默认，离线可用）

`data/catalog.json` 是一份**从源头拉取并清洗过的完整目录**，应用启动时会优先加载它，加载成功即不再访问任何外部 API。因此即使断网、在 CSP 受限的预览面板里、或部署到任何静态托管，都能浏览和播放全量电台。

- 文件由 `scripts/build_catalog.py` 生成：从 Radio Browser 公共目录分页拉取全量电台，去重、去控制字符、丢弃无效流、校验坐标、统一编码、HTTPS 优先、标签限量后写入。
- 当前快照：**53,186 座 / 224 国**，其中带坐标 11,060 座、HTTPS 流 34,657 座，体积约 24 MB。
- 文件的 `meta` 段记录生成时间、来源总量、各项清洗统计，状态栏会显示生成日期。
- 重新生成（需要联网）：

```bash
python3 scripts/build_catalog.py             # 全量
python3 scripts/build_catalog.py --limit 10000  # 只取前 1 万（调试）
python3 scripts/build_catalog.py --from-cache  # 用上次的原始缓存重跑清洗
python3 scripts/fill_coords.py              # 补全推算坐标（在 build 之后运行）
```

`fill_coords.py` 使用 `scripts/geodata/` 下的 GeoNames 数据（cities15000 + admin1CodesASCII，CC-BY 4.0）做四级补全：`city`（地区名精确命中城市）→ `admin1`（命中州/省，取该区最大城市）→ `country`（仅有国家码，取该国最大城市并按电台 ID 哈希做小幅抖动）。只填补缺失坐标，已有坐标一律保留。用 `--dry-run` 可先看各级命中数，`--no-jitter` 可关闭国家级抖动。

radio.garden 等站点的数据同样源自这类社区公共目录；直连其站点会被 Cloudflare 拦截，所以这里从源头取数并自行策展。

### 在线目录（本地文件缺失时回退）

若 `data/catalog.json` 不存在或读取失败，应用会退回原来的在线获取方式，通过 Radio Browser 的公开镜像获取电台目录：

```
# 列表分页：全量，不限制坐标
https://de1.api.radio-browser.info/json/stations/search
  ?hidebroken=true&order=votes&reverse=true&limit=1000&offset=N

# 地球专用：只取带经纬度的电台
https://de1.api.radio-browser.info/json/stations/search
  ?hidebroken=true&has_geo_info=true&order=votes&reverse=true&limit=3000

# 目录总量
https://de1.api.radio-browser.info/json/stats
```

- 多个镜像顺序回退，任一可用即可。
- 目录总量约 **52,981 座**（`/json/stats` 实时读取），其中前 4,000 座热门电台几乎都带坐标，越往后无坐标比例越高。
- 应用维护两个数据池：`stations`（全部，供列表与搜索）与 `geoStations`（带坐标子集，供地球）。
- 请求失败时自动使用 `js/builtin-stations.js` 中的内置目录，并在状态栏提供「重试连接」。

## 目录结构

```
.
├── index.html                # 页面结构
├── server.py                 # 极简本地服务：静态文件 + /api/state
├── css/
│   └── style.css             # 设计令牌、布局、响应式
├── js/
│   ├── app.js                # 状态管理、数据加载、播放器、视图切换
│   ├── flat-map.js           # 2D 兼容地图（Canvas）
│   ├── satellite-map.js      # 卫星地球（MapLibre + Esri 瓦片）
│   ├── world-geo.js          # 世界陆地轮廓数据
│   ├── builtin-stations.js   # 内置 620 座电台目录
│   └── fallback.js           # 最小回退数据集
├── data/
│   ├── catalog.json          # 本地全量目录（53,186 座，默认数据源）
│   └── catalog.raw.json      # 构建用原始缓存（.gitignore）
├── scripts/
│   ├── build_catalog.py      # 拉取 + 清洗 + 生成本地目录
│   ├── fill_coords.py        # 用 GeoNames 补全推算坐标
│   └── geodata/              # GeoNames 地名数据（CC-BY 4.0）
│       ├── cities15000.txt
│       └── admin1CodesASCII.txt
├── vendor/
│   ├── globe.gl.min.js       # 3D 地球库
│   └── maplibre-gl.js/.css   # 卫星地球库（5.23.0）
├── assets/
│   ├── earth-blue-marble.jpg # 地球贴图
│   ├── earth-topology.png    # 地形凹凸贴图
│   └── favicon.svg
├── .data/                    # 运行时生成：state.json（收藏与设置）
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
- **预览面板的 CSP**：部分 IDE 或文档预览器会注入 `Content-Security-Policy`，拦截对外部 API 的请求。由于默认读取同源的本地目录，这种情况不再影响浏览与播放；若连本地目录也无法读取，才会退回内置的 620 座目录。
- **公共流稳定性**：Radio Browser 的「最后检查正常」标记存在滞后，抽样约 70% 的流可即时连通。换台即可，不影响应用本身。
- **推算坐标的局限**：地名匹配的坐标只能定位到城市、州/省或国家，`country` 级做了小幅抖动用于示意，**不代表电台的真实发射位置**；详情与悬浮提示会明确标注。侧栏「精确坐标」只计目录直接提供的 1.1 万座，悬停可看推算数。约 1,178 座连国家码都缺失的电台仍无坐标，只在列表中展示，可搜索、筛选、收藏与播放。
- **卫星瓦片依赖网络**：卫星模式的影像运行时从 Esri 拉取，需要联网；断网或 CSP 拦截外部图片时该模式会空白，此时用 3D / 2D 模式（底图与电台数据全本地）。卫星地图需要 WebGL2，不支持时按钮会提示并阻止切换。影像版权归 Esri / Maxar，详见地图右下角署名。

## 许可

[MIT](LICENSE)
