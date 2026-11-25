# AETHER · 全球电波地图

在三维地球上探索并收听来自世界各地的电台。纯前端实现，无需构建，桌面 Web 与移动端 H5 自适应。收藏与设置由内置的极简本地服务（`server.py`，仅标准库）落到磁盘，本机任意浏览器打开都是同一份数据。

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](#)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](#)
[![No Build](https://img.shields.io/badge/build-none-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](#license)

## 功能特性

- **3D 地球**：可拖拽旋转、滚轮/双指缩放、空闲自动旋转；鼠标移入地图即暂停旋转、移开才恢复，保证光标所指与实际点中的电台一致。电台以贴地光点呈现，按热度做暗铜到亮金的颜色渐变。
- **地图点视觉（夜间灯火 · 低占用）**：三种地图的电台点统一在翠绿色域内按热度做明暗，热度越高越亮，推算坐标压暗融进地面而非变灰。为控制 CPU 占用，地图平时**没有任何循环动画或常驻光晕**；只有当前播放台带点播指示（3D 为 globe.gl 原生电波圈 + 单个 HTML 光点，2D / 卫星为静态高亮圈），切换播放时才更新。系统开启「减少动态效果」时连播放点的呼吸也停掉。
- **坐标补全与置信度**：目录原始只有约 1.1 万座带坐标；构建时用 GeoNames 地名数据把其余电台补到 97.8% 可定位，并按可信度标记来源（`original` / `nameCity` / `city` / `admin1` / `country`）。`nameCity` 表示电台名称里带有城市名（如「Radio Pakistan Lahore」「LBC London」），据此把原先随机/区域级的推算点校正到具体城市，并在详情中显示匹配依据。国家级坐标按人口加权选国内城市、再用 Natural Earth 国界做 point-in-polygon 约束，点落在各国真实边界内而非规则方块；台湾电台单独约束在台湾省内。推算点在地球与 2D 地图上更小、更灰，详情与悬浮提示会注明「位置估算」；右上角「估算位置」开关可一键隐藏推算点，只看真实坐标。真实坐标与推算坐标在统计中分开计数。
- **全量目录**：列表加载全部电台（含无坐标），滚动到底自动继续拉取；状态栏实时显示「已载入 X / 目录 52,981」。
- **3D / 2D / 卫星三种地图**：右上角可切换。3D 为 globe.gl 地球；2D 为 Leaflet + Esri World Imagery 卫星瓦片地图，无需 WebGL，支持滚轮、双指缩放至城市街道级（最高 19 级）。2D 采用整数级缩放（`zoomSnap: 1`）——小数级缩放会让瓦片层被 CSS transform 重采样，相邻瓦片边缘露出半透明缝、在深底图上呈现横竖网格条；整数级按原生像素对齐可彻底消除缝隙，缩放动画保留故滚轮过渡仍平滑；**卫星模式用 MapLibre 5.x globe 投影 + Esri World Imagery 免费卫星瓦片（与 radio.garden 同款做法），可一路放大到城市街道级**，电台光点覆盖在卫星影像上，点击即可收听。三种模式共用同一份电台数据与详情/播放状态。
- **2D 概览视野**：基础瓦片尺寸随舞台宽度自适应，世界地图在初始级别恰好铺满舞台宽度、左右不留空白；中心按全部电台的地理范围定位，经度方向覆盖所有电台，只在几乎没有电台的极地区域做纵向裁切。缩放仍保持整数级，因此不会有瓦片缝。
- **首屏加载**：启动时并行读取跨机设置与本地目录，遮罩只等数据解析与列表渲染即消失，不等 WebGL 地球初始化（软件渲染环境很慢）；地球随后在浏览器空闲时后台构建，不阻塞首屏内容与交互。`boot()` 中数据加载、状态同步、地球初始化彼此解耦，收藏在跨机状态读回后才恢复。
- **电台列表**：网格列表，支持按投票数、收听数、名称、码率排序，并可分批从全球目录继续加载。
- **国家筛选**：列表头部按国家下拉筛选，选项由已加载电台动态聚合，附带国旗与中文国名及数量；切换筛选时会向目录补全对应国家的电台，而非只筛本地已载入的部分。
- **搜索与筛选**：输入即过滤（名称、国家、地区、语言、风格标签），并同时以「电台名」和「风格标签」两种方式向目录检索，因此 `jazz`、`reggae` 这类流派词也能命中；顶部提供热门风格快捷筛选，所有筛选条件可叠加使用。
- **收藏**：一键收藏，支持「只看收藏」模式。默认由本地服务写入 `.data/state.json`，换浏览器也能读到同一份收藏；没有该接口时自动退回 `localStorage`。
- **播放器**：播放/暂停、上一台/下一台、音量记忆、加载与断流提示。
- **格式自适应**：用 `audio.canPlayType()` 探测本机浏览器对 MP3 / AAC / OGG / Opus / FLAC 的支持，加载时自动剔除无法解码的电台。
- **频道体检**：定时并发探测全部电台流，把连不上、返回错误页、启动过慢或播放卡顿的电台从列表、地球和搜索结果中隐藏。可一键切回「显示全部」，详情页也可加 `?all=1` 临时绕过。
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

`server.py` 会同时监听 IPv4（127.0.0.1）与 IPv6（::1）两个回环地址。新版浏览器把 `localhost` 优先解析为 `::1`，只绑 IPv4 会让页面直接连不上，所以两个协议族各起一份，端口相同、都只对本机可见。若想指定地址，可用 `AETHER_HOST`、`AETHER_PORT` 环境变量覆盖。

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
| 2D 备用地图 | Leaflet 1.9.4 + Esri World Imagery 卫星瓦片，无需 WebGL |
| 卫星地球 | [MapLibre GL JS](https://maplibre.org/) 5.23.0（globe 投影）+ Esri World Imagery 卫星瓦片，均本地化于 `vendor/`；瓦片运行时从 Esri 拉取、无需 API key |
| 数据 | [Radio Browser](https://www.radio-browser.info/) 公共目录 + GeoNames 地名数据，离线封装于 `data/` |
| 持久化 | 本地服务落盘 + `localStorage` 回退 |

设计方向参考 [Radio Garden](https://radio.garden)：**浅色界面 + 深色地图窗口**。界面本体是纸白与浅灰（`#f4f6f5` 底 / `#ffffff` 卡片），正文近黑（`#0c1915`）压在浅底上，强调色压深为 `#0a7d4a`，按钮一律实心填充（绿底白字或白色卡片 + 描边 + 微投影），避免低对比的「透明描边幽灵钮」；地球/地图是一块独立的深色窗口，让绿色光点成为画面唯一高光。

所有颜色走 `css/style.css` 顶部的 CSS 变量，`html[data-theme="dark"]` 只覆盖同名变量即得到完整暗色主题，布局与动效零改动；右上角太阳/月亮按钮切换，选择存于 `localStorage`（键 `aether:theme`），首屏前由内联脚本定主题以避免闪白/闪黑，默认浅色。

几何上统一 8/12/16/22/999px 圆角阶，交互共用一条缓动曲线（`cubic-bezier(.22,1,.36,1)`）与 140/240/400ms 三档时长，消除方角与硬跳变。地球贴图由 `assets/earth-blue-marble.jpg` 经灰度化 + 中性 duotone + 分段提亮生成 `assets/earth-night.jpg`（海洋近黑、大陆石墨灰），球体另抬高环境光，使夜半球仍保留大陆轮廓。2D 与卫星影像轻度压暗降饱和，并额外铺一层本地陆地轮廓作为离线兜底。正文与控件配色满足 WCAG AA 对比度。

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

`fill_coords.py` 使用 `scripts/geodata/` 下的 GeoNames 数据（cities15000 + admin1CodesASCII，CC-BY 4.0）与 Natural Earth 110m 国界（public domain）做四级补全：`city`（地区名精确命中城市）→ `admin1`（命中州/省，取该区最大城市）→ `country`（仅有国家码，按人口加权选国内城市，用国界做 point-in-polygon 约束后做确定性抖动）。台湾是中国的省份，`countrycode=tw` 的电台使用单独的台湾省边界采样，不作为中国以外区域处理。只填补缺失坐标，已有坐标一律保留。用 `--dry-run` 可先看各级命中数，`--no-jitter` 可让国家级直接取最大城市中心。

在此基础上，`refine_coords_by_name.py` 再根据**电台名称里的地名**复核低可信度推算点：只改 `country` 与 `admin1` 级，在国家码约束下匹配 GeoNames 城市（双词以上人口 ≥5 万、单词 ≥20 万，并排除州省缩写等易误判词），命中后标记为 `nameCity` 并记录 `nameHint`。本轮回修 3,087 座（国家级 2,115 / 行政级 972）；原始坐标 `original` 与已有城市匹配 `city` 不受影响。脚本先备份 `data/catalog.before-name-refine.json`，可用 `--undo` 一键恢复；`--dry-run` 只看命中样例。

```bash
python3 scripts/fill_coords.py                       # 第一步：GeoNames + 国界补全
python3 scripts/refine_coords_by_name.py --dry-run   # 第二步：先看名称匹配质量
python3 scripts/refine_coords_by_name.py             # 确认后写回
python3 scripts/refine_coords_by_name.py --undo      # 需要时回滚
```

radio.garden 等站点的数据同样源自这类社区公共目录；直连其站点会被 Cloudflare 拦截，所以这里从源头取数并自行策展。

### 频道体检（自动隐藏失效/卡顿电台）

`python3 server.py` 启动后会在后台**每天凌晨 03:00（本机时间）自动体检一次**，固定时刻不随启动时间漂移；仅当从未体检过时，启动 90 秒后补跑一次。体检在独立线程进行，不影响页面响应，过程中逐步落盘，刷新页面即可看到最新过滤结果。可用环境变量调整：`AETHER_HEALTH_AUTORUN=0` 关闭自动体检、`AETHER_HEALTH_HOUR=4` / `AETHER_HEALTH_MINUTE=30` 改体检时刻、`AETHER_HEALTH_WORKERS=80` 改并发。本机的 launchd 服务 `com.joel.aether-radio` 已在配置中固定为 03:00，改时刻需编辑 `~/Library/LaunchAgents/com.joel.aether-radio.plist` 并重启服务。使用纯静态托管（不运行 `server.py`）时没有自动调度，需手动运行体检脚本。

```bash
python3 scripts/check_streams.py                    # 按默认参数全量体检
python3 scripts/check_streams.py --limit 2000       # 只体检前 2000 座（调试）
python3 scripts/check_streams.py --force            # 忽略 24 小时缓存，全部重检
python3 scripts/check_streams.py --workers 60       # 网络慢时降低并发
```

判定「可正常播放且不卡顿」的标准：HTTP/HTTPS 状态 200/206、响应是音频而非错误页、首包 8 秒内到达、采样窗口（默认 2.5 秒）内数据块间隔不超过 1.5 秒、有效码率不低于 32 kbps 且不低于目录标称码率的 35%。参数均可用命令行调整。

页面打开期间会每 5 分钟检查一次体检文件；发现结果更新时静默重建列表，不弹提示，也不打断正在播放的电台。结果写入两个文件（运行时生成，已加入 `.gitignore`）：

| 文件 | 内容 |
| --- | --- |
| `data/stream-health.json` | 每座电台的判定结果、失败原因、有效码率、首包耗时 |
| `data/stream-bad.json` | 仅失效电台 id 列表，供前端加载时过滤 |

容错设计：文件缺失、JSON 损坏或生成时间超过 14 天时前端不做任何过滤；状态栏的「显示全部 / 仅显示可用」按钮可随时切回，访问 `index.html?all=1` 也能临时看到全量电台。若要让静态托管版本也带过滤，需把这两个生成文件一并提交或上传到站点。

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
│   ├── flat-map.js           # 2D 卫星地图（Leaflet）
│   ├── satellite-map.js      # 卫星地球（MapLibre + Esri 瓦片）
│   ├── world-geo.js          # 世界陆地轮廓数据
│   ├── builtin-stations.js   # 内置 620 座电台目录
│   └── fallback.js           # 最小回退数据集
├── data/
│   ├── catalog.json          # 本地全量目录（53,186 座，默认数据源）
│   ├── catalog.raw.json      # 构建用原始缓存（.gitignore）
│   └── catalog.before-name-refine.json  # 名称回修前备份（.gitignore）
├── scripts/
│   ├── build_catalog.py      # 拉取 + 清洗 + 生成本地目录
│   ├── check_streams.py      # 并发体检电台流，标记失效/卡顿频道
│   ├── fill_coords.py        # 用 GeoNames + 国界补全推算坐标
│   ├── refine_coords_by_name.py  # 依据电台名称里的地名校正推算坐标
│   └── geodata/              # GeoNames 地名数据（CC-BY 4.0）+ Natural Earth 国界
│       ├── cities15000.txt
│       ├── admin1CodesASCII.txt
│       └── countries-110m.json  # 110m 国界 + 台湾省子区域（public domain）
├── vendor/
│   ├── globe.gl.min.js       # 3D 地球库
│   └── maplibre-gl.js/.css   # 卫星地球库（5.23.0）
├── assets/
│   ├── earth-night.jpg       # 暗色地球贴图（由 blue-marble 生成，实际加载）
│   ├── earth-blue-marble.jpg # 地球原始贴图（生成 earth-night 的源，可留作替换基准）
│   ├── earth-topology.png    # 地形凹凸贴图
│   └── favicon.svg
├── data/stream-*.json        # 运行时生成：频道体检结果
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
- **公共流稳定性**：Radio Browser 的「最后检查正常」标记存在滞后，抽样约 70% 的流可即时连通。频道体检按当前网络与本机浏览器环境判定，结果会随时间变化，因此定时重检；仍可能有瞬时失效的电台，换台即可。
- **推算坐标的局限**：地名匹配的坐标只能定位到城市、州/省或国家，`country` 级在国界内按城市加权采样，**只代表大致区域，不代表电台的真实发射位置**；详情与悬浮提示会明确标注。侧栏「精确坐标」只计目录直接提供的 1.1 万座，悬停可看推算数。约 1,178 座连国家码都缺失的电台仍无坐标，只在列表中展示，可搜索、筛选、收藏与播放。
- **卫星瓦片依赖网络**：2D 与卫星模式的影像运行时从 Esri 拉取，需要联网；断网或 CSP 拦截外部图片时该模式会空白，此时用 3D 模式（底图与电台数据全本地）。卫星地图需要 WebGL2，不支持时按钮会提示并阻止切换。影像版权归 Esri / Maxar，详见地图右下角署名。

## 许可

[MIT](LICENSE)
