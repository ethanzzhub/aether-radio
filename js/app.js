/* ============================================================
   AETHER · 全球电波地图  —  应用逻辑
   数据源：Radio Browser 公共目录（无需密钥）
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- 常量与状态 ---------------- */
  const API_BASES = [
    'https://de1.api.radio-browser.info',
    'https://nl1.api.radio-browser.info',
    'https://fi1.api.radio-browser.info'
  ];

  const GENRE_LABELS = {
    jazz: '爵士', classical: '古典', rock: '摇滚', news: '新闻', talk: '脱口秀',
    electronic: '电子', pop: '流行', hiphop: '嘻哈', 'hip hop': '嘻哈', country: '乡村',
    sports: '体育', ambient: '氛围', blues: '布鲁斯', metal: '金属', dance: '舞曲',
    chill: '放松', techno: '电子舞曲', house: '浩室', folk: '民谣', soul: '灵魂乐',
    reggae: '雷鬼', latin: '拉丁', world: '世界音乐', instrumental: '器乐',
    '70s': '70年代', '80s': '80年代', '90s': '90年代', oldies: '怀旧',
    christian: '宗教', public: '公共广播', community: '社区电台', indie: '独立',
    opera: '歌剧', comedy: '喜剧', business: '财经', kids: '儿童',
    radio: '电台', music: '音乐', musica: '音乐', estacion: '电台',
    online: '网络电台', fm: 'FM', internet: '网络电台', libre: '自由',
    noticias: '新闻', informacion: '资讯', regional: '地方', local: '本地'
  };

  const state = {
    stations: [],          // 全量已载入电台（列表用，含无坐标）
    geoStations: [],       // 其中有坐标的子集（地球用）
    stationIndex: new Set(),
    geoIndex: new Set(),
    catalogTotal: 0,       // 目录总量，来自 /json/stats
    view: 'globe',
    query: '',
    genre: '',
    country: '',
    countryName: '',
    favoritesOnly: false,
    sort: 'votes',
    visibleCount: 30,
    current: null,
    playing: false,
    loading: false,
    favorites: new Set(readJSON('aether:favorites', [])),
    volume: Number(readJSON('aether:volume', 0.8)),
    dataSource: 'api',
    initialLimit: 1000,    // 首屏加载量（目录总量 5 万+）
    pageSize: 1000,        // 每次「加载更多」从目录追加的数量
    codecSupport: {},
    mapMode: 'auto',       // auto | 3d | 2d
    nextOffset: 1000,
    searchOffset: 0,
    hasMore: true,
    searchHasMore: true,
    loadingMore: false
  };

  let globe = null;
  let globeReady = false;
  let flatMap = null;
  let rotateTimer = null;
  let searchTimer = null;
  let toastTimer = null;
  let searchGeneration = 0;
  let autoLoadAt = 0;

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');

  /* ---------------- 工具函数 ---------------- */
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }
  function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 隐私模式下忽略 */ }
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function flagEmoji(cc) {
    if (!cc || cc.length !== 2 || !/^[a-z]{2}$/i.test(cc)) return '🌐';
    return String.fromCodePoint(...cc.toUpperCase().split('').map((c) => 127397 + c.charCodeAt(0)));
  }
  // 国家代码转本地化名称（优先中文）
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['zh-Hans'], { type: 'region' }); } catch (_) { regionNames = null; }
  function countryLabel(cc, fallback) {
    if (!cc) return fallback || '未知地区';
    if (regionNames) {
      try {
        const name = regionNames.of(cc.toUpperCase());
        if (name && name.toUpperCase() !== cc.toUpperCase()) return name;
      } catch (_) { /* 忽略无效代码 */ }
    }
    return fallback || cc.toUpperCase();
  }
  function letterURI(name) {
    const ch = esc((String(name || '◉').trim()[0] || '◉'));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">'
      + '<rect width="96" height="96" fill="#e8e2d6"/>'
      + '<text x="48" y="63" text-anchor="middle" font-family="Georgia,serif" font-size="46" fill="#94621c">'
      + ch + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  function imgSrc(s) {
    // 仅使用 HTTPS 台标：HTTP 图片在 HTTPS 页面或受 CSP 限制的环境会被拦截
    return (s.favicon && /^https:\/\//i.test(s.favicon)) ? s.favicon : letterURI(s.name);
  }
  // 供内联 onerror 调用，修复失效的台标
  window.__logoError = function (img) {
    img.onerror = null;
    img.src = letterURI(img.getAttribute('data-letter') || '◉');
  };
  function logoHTML(s) {
    const letter = esc((s.name || '◉').trim()[0] || '◉');
    // 字母垫在底层，台标为透明图或加载失败时仍可辨识
    return '<span class="logo-box">'
      + '<span class="logo-letter" aria-hidden="true">' + letter + '</span>'
      + '<img src="' + esc(imgSrc(s)) + '" alt="" loading="lazy" '
      + 'data-letter="' + letter + '" onerror="__logoError(this)">'
      + '</span>';
  }
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 3200);
  }
  function normalize(s) {
    return {
      id: s.stationuuid,
      name: String(s.name || '未命名电台').trim(),
      url: s.url_resolved || s.url || '',
      favicon: s.favicon || '',
      country: s.country || '',
      cc: (s.countrycode || '').toLowerCase(),
      region: s.state || '',
      lang: s.language || '',
      tags: String(s.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      votes: Number(s.votes) || 0,
      clicks: Number(s.clickcount) || 0,
      codec: s.codec || '',
      bitrate: Number(s.bitrate) || 0,
      lat: Number(s.geo_lat),
      lng: Number(s.geo_long),
      homepage: s.homepage || ''
    };
  }
  // 浏览器对常见电台编码的实际支持能力
  function buildCodecSupport() {
    const a = document.createElement('audio');
    const test = (mime) => { try { return !!a.canPlayType(mime); } catch (_) { return false; } };
    return {
      MP3: test('audio/mpeg') || test('audio/mp3'),
      AAC: test('audio/aac') || test('audio/mp4; codecs="mp4a.40.2"') || test('audio/mp4'),
      'AAC+': test('audio/aac') || test('audio/mp4'),
      MP4: test('audio/mp4'),
      OGG: test('audio/ogg') || test('audio/ogg; codecs="vorbis"'),
      OPUS: test('audio/ogg; codecs="opus"') || test('audio/webm; codecs="opus"'),
      FLAC: test('audio/flac'),
      WMA: test('audio/x-ms-wma'),
      UNKNOWN: true   // 未知编码给机会，靠流地址后缀再判断
    };
  }
  function codecOf(s) {
    const c = String(s.codec || '').toUpperCase().trim();
    if (c) return c;
    const path = (s.url || '').split('?')[0].toLowerCase();
    if (/\.mp3$/.test(path)) return 'MP3';
    if (/\.(aac|m4a|mp4)$/.test(path)) return 'AAC';
    if (/\.ogg$/.test(path)) return 'OGG';
    if (/\.opus$/.test(path)) return 'OPUS';
    if (/\.flac$/.test(path)) return 'FLAC';
    return 'UNKNOWN';
  }
  function usable(s) {
    if (!s.url || !/^https?:\/\//i.test(s.url)) return false;
    // HTTPS 页面不能播放 HTTP 音频流（浏览器混合内容拦截）
    if (window.location.protocol === 'https:' && !/^https:/i.test(s.url)) return false;
    // 过滤浏览器不支持的音频编码
    const codec = codecOf(s);
    if (state.codecSupport[codec] === false) return false;
    if (codec === 'UNKNOWN') return true;
    return true;
  }

  /* ---------------- 数据获取 ---------------- */
  async function apiGet(path, params, timeoutMs) {
    let lastError;
    for (const base of API_BASES) {
      const url = base + path + '?' + new URLSearchParams(params).toString();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs || 9000);
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data === null || typeof data !== 'object') throw new Error('响应格式异常');
        return data;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
      }
    }
    throw lastError || new Error('电台目录不可用');
  }

  let lastLoadBlocked = false;

  // 把一批电台同时并入「全量池」与「地球池」，按 id 去重
  function ingest(list, reset) {
    if (reset) {
      state.stations = [];
      state.geoStations = [];
      state.stationIndex = new Set();
      state.geoIndex = new Set();
    }
    for (const s of list) {
      if (!s || !s.id) continue;
      if (!state.stationIndex.has(s.id)) {
        state.stationIndex.add(s.id);
        state.stations.push(s);
      }
      if (Number.isFinite(s.lat) && Number.isFinite(s.lng) && !state.geoIndex.has(s.id)) {
        state.geoIndex.add(s.id);
        state.geoStations.push(s);
      }
    }
  }

  // 目录总量（用于状态栏展示「/ 目录 52,981」）
  async function loadCatalogTotal() {
    try {
      const stats = await apiGet('/json/stats', {}, 8000);
      if (stats && Number(stats.stations) > 0) {
        state.catalogTotal = Number(stats.stations);
        updateResultMeta();
      }
    } catch (_) { /* 统计接口失败不影响主流程 */ }
  }

  async function loadStations() {
    const started = performance.now();
    try {
      // 主请求不带坐标限制：列表需要全部电台
      const raw = await apiGet('/json/stations/search', {
        hidebroken: 'true',
        order: 'votes',
        reverse: 'true',
        limit: String(state.initialLimit)
      }, 20000);
      if (!raw.length) throw new Error('空结果');
      ingest(raw.map(normalize).filter(usable), true);
      state.dataSource = 'api';
      state.nextOffset = raw.length;
      state.hasMore = true;
      lastLoadBlocked = false;
    } catch (err) {
      // 极短时间内的失败通常是 CSP / 本地策略直接拦截，而非真实网络超时
      const elapsed = performance.now() - started;
      lastLoadBlocked = elapsed < 500;
      const builtin = (window.BUILTIN_STATIONS || []).map(normalize).filter(usable);
      const fallback = (window.FALLBACK_STATIONS || []).map(normalize).filter(usable);
      ingest(builtin.length ? builtin : fallback, true);
      state.dataSource = builtin.length ? 'builtin' : 'fallback';
      state.hasMore = false;
    }
    if (!state.stations.length) {
      ingest((window.BUILTIN_STATIONS || window.FALLBACK_STATIONS || []).map(normalize), true);
    }
    state.stations.sort((a, b) => b.votes - a.votes);
    state.geoStations.sort((a, b) => b.votes - a.votes);
    buildGenreChips();
    buildCountryOptions();
    updateStats();
    updateGlobeData();
    renderList();
    updateResultMeta();
    if (state.dataSource !== 'api') {
      toast(lastLoadBlocked
        ? '所在环境限制了外部数据请求，已启用内置 ' + state.stations.length + ' 座电台'
        : '暂时连不上电台目录，已启用内置 ' + state.stations.length + ' 座电台', true);
      return;
    }
    // 后台补充有地理坐标的电台，让地球更完整（不阻塞、不重排列表）
    loadGeoPool();
    loadCatalogTotal();
  }

  // 筛选/搜索时向目录补全结果，避免只筛本地已载入的池
  async function supplementFilter() {
    if (state.dataSource !== 'api') return;
    const base = { hidebroken: 'true', order: 'votes', reverse: 'true', limit: '400' };
    const cc = state.country ? { countrycode: state.country.toUpperCase() } : {};
    const reqs = [];
    if (state.query) {
      // 名称匹配 + 标签匹配（用户常搜流派词，如 jazz、reggae）
      reqs.push(Object.assign({}, base, cc, { name: state.query },
        state.genre ? { tag: state.genre } : {}));
      if (!state.genre) reqs.push(Object.assign({}, base, cc, { tag: state.query }));
    } else if (state.country || state.genre) {
      reqs.push(Object.assign({}, base, cc, state.genre ? { tag: state.genre } : {}));
    }
    if (!reqs.length) return;
    const results = await Promise.allSettled(reqs.map((p) => apiGet('/json/stations/search', p, 15000)));
    const merged = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) merged.push.apply(merged, r.value);
    }
    if (!merged.length) return;
    const before = state.stations.length;
    ingest(merged.map(normalize).filter(usable), false);
    if (state.stations.length === before) return;
    buildGenreChips();
    buildCountryOptions();
    updateStats();
    updateGlobeData();
    renderList();
    updateResultMeta();
  }

  // 专门为地球补充有坐标的电台；结果同时进列表池
  async function loadGeoPool() {
    try {
      const raw = await apiGet('/json/stations/search', {
        hidebroken: 'true',
        has_geo_info: 'true',
        order: 'votes',
        reverse: 'true',
        limit: '3000'
      }, 25000);
      if (!Array.isArray(raw) || !raw.length) return;
      const valid = raw.map(normalize).filter(usable);
      let added = 0;
      for (const s of valid) {
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
        if (!state.geoIndex.has(s.id)) {
          state.geoIndex.add(s.id);
          state.geoStations.push(s);
          added += 1;
        }
        if (!state.stationIndex.has(s.id)) {
          state.stationIndex.add(s.id);
          state.stations.push(s);
        }
      }
      if (!added) return;
      state.geoStations.sort((a, b) => b.votes - a.votes);
      updateStats();
      updateGlobeData();
      updateResultMeta();
    } catch (_) { /* 地球池补充失败不影响主流程 */ }
  }

  async function retryConnection() {
    if (state.loadingMore) return;
    $('resultMeta').innerHTML = '正在重新连接…';
    await loadStations();
  }

  // 从目录追加下一批电台（保留地球坐标筛选，分页去重）
  async function loadMoreStations() {
    const moreAvailable = state.query ? state.searchHasMore : state.hasMore;
    if (state.loadingMore || !moreAvailable || state.dataSource !== 'api') return;
    state.loadingMore = true;
    const btn = $('loadMore');
    const original = btn.textContent;
    btn.textContent = '正在从全球目录加载…';
    try {
      const params = {
        hidebroken: 'true',
        order: 'votes',
        reverse: 'true',
        limit: String(state.pageSize),
        offset: String(state.query ? state.searchOffset : state.nextOffset)
      };
      // 搜索态下按关键词翻页，否则按热门电台翻页（不做坐标限制，列表要全量）
      if (state.query) params.name = state.query;
      const raw = await apiGet('/json/stations/search', params, 20000);
      const before = state.stations.length;
      ingest(raw.map(normalize).filter(usable), false);
      const fresh = state.stations.length - before;
      if (fresh) {
        state.stations.sort((a, b) => b.votes - a.votes);
        state.geoStations.sort((a, b) => b.votes - a.votes);
        buildGenreChips();
        buildCountryOptions();
        updateStats();
        updateGlobeData();
        renderList();
      }
      if (state.query) {
        state.searchOffset += raw.length;
        state.searchHasMore = raw.length >= state.pageSize;
      } else {
        state.nextOffset += raw.length;
        state.hasMore = raw.length >= state.pageSize;
      }
      updateResultMeta();
      toast(fresh ? '已追加 ' + fresh + ' 座电台' : '没有更多新电台了');
    } catch (err) {
      toast('加载失败，请稍后重试', true);
    } finally {
      state.loadingMore = false;
      btn.textContent = original;
      renderList();
    }
  }

  function updateResultMeta() {
    const total = state.stations.length;
    const filtered = getFiltered().length;
    const catalog = state.catalogTotal ? ' / 目录 <b>' + state.catalogTotal.toLocaleString() + '</b>' : '';
    let html;
    if (state.favoritesOnly) html = '收藏 <b>' + filtered + '</b> / 已载入 <b>' + total.toLocaleString() + '</b> 座';
    else if (state.query) html = '匹配 <b>' + filtered + '</b> / 已载入 <b>' + total.toLocaleString() + '</b> 座';
    else if (state.genre || state.country) html = '筛选 <b>' + filtered + '</b> / 已载入 <b>' + total.toLocaleString() + '</b> 座';
    else html = '已载入 <b>' + total.toLocaleString() + '</b> 座' + catalog + (state.hasMore ? ' · 可继续加载' : '');
    if (state.dataSource !== 'api') {
      html += ' · 内置目录 <button class="retry-link" type="button">重试连接</button>';
    }
    $('resultMeta').innerHTML = html;
  }

  async function liveSearch(query) {
    const generation = ++searchGeneration;
    try {
      const raw = await apiGet('/json/stations/search', {
        name: query,
        hidebroken: 'true',
        order: 'votes',
        reverse: 'true',
        limit: '80'
      }, 7000);
      if (generation !== searchGeneration) return;
      const incoming = raw.map(normalize).filter(usable);
      if (!incoming.length) return;
      const before = state.stations.length;
      ingest(incoming, false);
      if (state.stations.length > before) {
        buildGenreChips();
        buildCountryOptions();
        updateStats();
        updateGlobeData();
        renderList();
        updateResultMeta();
      }
    } catch (_) { /* 静默失败，保留本地搜索结果 */ }
  }

  /* ---------------- 筛选与排序 ---------------- */
  function applyFilters(list) {
    let out = list;
    if (state.favoritesOnly) out = out.filter((s) => state.favorites.has(s.id));
    if (state.genre) {
      const g = state.genre.toLowerCase();
      out = out.filter((s) => s.tags.some((t) => t.toLowerCase() === g || t.toLowerCase().includes(g)));
    }
    if (state.country) {
      out = out.filter((s) => (s.cc || '') === state.country);
    }
    if (state.query) {
      const q = state.query.toLowerCase();
      out = out.filter((s) => (
        s.name + ' ' + s.country + ' ' + s.region + ' ' + s.lang + ' ' + s.tags.join(' ')
      ).toLowerCase().includes(q));
    }
    return out;
  }
  // 列表：全量池（含无坐标电台）
  function getFiltered() { return applyFilters(state.stations); }
  // 地球：仅带坐标的子集
  function getGlobeStations() { return applyFilters(state.geoStations); }
  function getSorted(list) {
    const copy = list.slice();
    switch (state.sort) {
      case 'name': return copy.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      case 'bitrate': return copy.sort((a, b) => b.bitrate - a.bitrate);
      case 'clickcount': return copy.sort((a, b) => b.clicks - a.clicks);
      default: return copy.sort((a, b) => b.votes - a.votes);
    }
  }

  /* ---------------- 地图（3D 地球 / 2D 备用） ---------------- */
  function hasWebGL() {
    try {
      const c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (_) { return false; }
  }
  function setMapMode(mode) {
    state.mapMode = mode;
    document.querySelectorAll('#mapModeSwitch button').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mode === mode));
    if (mode === '2d') {
      if (globeReady && globe) {
        globe.renderer().domElement.style.display = 'none';
        if (globe.controls()) globe.controls().autoRotate = false;
      }
      if (flatMap) { flatMap.show(); flatMap.refresh(); }
      $('globeGuide').lastChild.textContent = ' 拖动平移 · 滚轮缩放 · 点击光点收听';
    } else {
      if (flatMap) flatMap.hide();
      if (globeReady && globe) {
        globe.renderer().domElement.style.display = '';
        globe.controls().autoRotate = true;
        const el = $('globeContainer');
        globe.width(el.clientWidth); globe.height(el.clientHeight);
      }
      $('globeGuide').lastChild.textContent = window.matchMedia('(pointer: coarse)').matches
        ? ' 拖动旋转 · 双指缩放 · 点击光点收听'
        : ' 拖动旋转 · 滚轮缩放 · 点击光点收听';
    }
  }
  function initFlatMap() {
    if (flatMap) return;
    const el = $('globeContainer');
    flatMap = window.FlatMap({
      container: el,
      getStations: getGlobeStations,
      getCurrent: () => state.current,
      onSelect: (s) => { selectStation(s); play(s); },
      heatColor: (votes, isCurrent) => heatColor(votes, isCurrent, 'flat')
    });
  }

  function initGlobe() {
    // 无 WebGL 或 3D 组件异常时自动降级到 2D 地图
    if (!hasWebGL() || typeof window.Globe !== 'function') {
      initFlatMap();
      setMapMode('2d');
      toast('当前浏览器不支持 3D 地球，已切换为 2D 地图', false);
      return;
    }
    const el = $('globeContainer');
    try {
      globe = window.Globe({ animateIn: true, enablePointerInteraction: true })
        (el)
        .backgroundColor('rgba(0,0,0,0)')
        .globeImageUrl('assets/earth-blue-marble.jpg')
        .bumpImageUrl('assets/earth-topology.png')
        .showAtmosphere(true)
        .atmosphereColor('#c79a52')
        .atmosphereAltitude(0.15)
        .pointLat((d) => d.lat)
        .pointLng((d) => d.lng)
        .pointColor((d) => heatColor(d.votes, state.current && d.id === state.current.id))
        .pointAltitude(0.006)
        .pointRadius((d) => (state.current && d.id === state.current.id) ? 0.5 : 0.3)
        .pointLabel((d) => globeTip(d))
        .onPointClick((d) => { selectStation(d); play(d); })
        .ringsData([])
        .ringLat((d) => d.lat)
        .ringLng((d) => d.lng)
        .ringColor(() => (t) => 'rgba(255,126,70,' + (1 - t) * 0.85 + ')')
        .ringMaxRadius(3.2)
        .ringPropagationSpeed(1.6)
        .ringRepeatPeriod(1200);

      globe.width(el.clientWidth || 800);
      globe.height(el.clientHeight || 600);
      globe.pointOfView({ lat: 20, lng: 12, altitude: window.innerWidth < 760 ? 2.7 : 2.1 }, 0);

      const controls = globe.controls();
      controls.autoRotate = true;
      controls.autoRotateSpeed = 0.32;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 120;
      controls.maxDistance = 620;

      const pauseRotate = () => {
        controls.autoRotate = false;
        clearTimeout(rotateTimer);
        rotateTimer = setTimeout(() => { controls.autoRotate = true; }, 7000);
      };
      el.addEventListener('pointerdown', pauseRotate);
      el.addEventListener('wheel', pauseRotate, { passive: true });
      el.addEventListener('pointerleave', () => {
        if (window.matchMedia('(pointer: fine)').matches) {
          clearTimeout(rotateTimer);
          controls.autoRotate = true;
        }
      });

      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
          if (globe && el.clientWidth && el.clientHeight) {
            globe.width(el.clientWidth);
            globe.height(el.clientHeight);
          }
        });
        ro.observe(el);
      }
      globeReady = true;
      updateGlobeData();
    } catch (err) {
      globeReady = false;
      console.error('Globe init failed:', err);
      initFlatMap();
      setMapMode('2d');
      toast('3D 地球初始化失败，已切换为 2D 地图', true);
    }
  }
  // 热度配色：低热度偏沉、高热度偏亮。
  // variant='flat' 用于浅色 2D 地图（深色系），默认用于深色地球贴图（亮色系）。
  function heatColor(votes, isCurrent, variant) {
    const flat = variant === 'flat';
    if (isCurrent) return flat ? '#b03a12' : '#ff8a5c';
    const t = Math.min(1, Math.log10(1 + (votes || 0)) / Math.log10(1 + 300000));
    const stops = flat
      ? [[178, 136, 76], [156, 98, 42], [132, 62, 28], [104, 38, 20]]
      : [[198, 158, 94], [234, 190, 110], [252, 216, 136], [255, 244, 208]];
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const local = t * (stops.length - 1) - seg;
    const a = stops[seg], b = stops[seg + 1];
    return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * local)).join(',') + ')';
  }
  function globeTip(d) {
    return '<div class="globe-tip">' + logoHTML(d)
      + '<div><b>' + esc(d.name) + '</b><small>' + flagEmoji(d.cc) + ' '
      + esc(countryLabel(d.cc, d.country)) + ' · ' + esc((d.tags[0] || 'RADIO').toUpperCase())
      + '</small></div></div>';
  }
  function updateGlobeData() {
    if (!globeReady || !globe) return;
    // 地球只渲染带坐标的子集（列表仍可查看全部电台）
    const points = getGlobeStations().filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
    globe.pointsData(points);
    globe.pointColor((d) => heatColor(d.votes, state.current && d.id === state.current.id));
    globe.pointAltitude(0.006);
    globe.pointRadius((d) => (state.current && d.id === state.current.id) ? 0.5 : 0.3);
    globe.ringsData(state.current && Number.isFinite(state.current.lat) ? [state.current] : []);
    if (flatMap && state.mapMode === '2d') flatMap.refresh();
  }
  function focusGlobe(s) {
    if (state.mapMode === '2d') return;
    if (!globeReady || !globe || !Number.isFinite(s.lat)) return;
    globe.pointOfView({ lat: s.lat, lng: s.lng, altitude: 1.55 }, 950);
  }

  /* ---------------- 渲染 ---------------- */
  function buildGenreChips() {
    const counts = {};
    state.stations.forEach((s) => s.tags.forEach((t) => {
      const k = t.toLowerCase();
      if (k.length > 2 && k.length < 22) counts[k] = (counts[k] || 0) + 1;
    }));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 11).map((x) => x[0]);
    const html = ['<button class="chip' + (state.genre ? '' : ' is-active') + '" data-genre="" type="button">全部频率</button>']
      .concat(top.map((g) => '<button class="chip' + (state.genre === g ? ' is-active' : '') + '" data-genre="' + esc(g) + '" type="button">' + esc(GENRE_LABELS[g] || g) + '</button>'))
      .join('');
    $('genreChips').innerHTML = html;
  }
  // 国家下拉：按电台数量排序，保留当前选择
  function buildCountryOptions() {
    const sel = $('countrySelect');
    if (!sel) return;
    const map = new Map();
    for (const s of state.stations) {
      const cc = s.cc || '';
      const cur = map.get(cc) || { name: s.country || '未知地区', count: 0 };
      cur.count += 1;
      map.set(cc, cur);
    }
    const items = Array.from(map.entries())
      .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name, 'zh-Hans-CN'));
    const parts = ['<option value="">全部国家</option>'];
    for (const [cc, v] of items) {
      parts.push('<option value="' + esc(cc) + '">' + flagEmoji(cc) + ' '
        + esc(countryLabel(cc, v.name)) + ' · ' + v.count + '</option>');
    }
    sel.innerHTML = parts.join('');
    if (state.country && map.has(state.country)) {
      sel.value = state.country;
    } else if (state.country) {
      // 数据源切换后原国家已不存在，重置筛选
      state.country = '';
      state.countryName = '';
      sel.value = '';
    }
  }

  function updateStats() {
    $('statStations').textContent = state.stations.length.toLocaleString();
    $('statCountries').textContent = new Set(state.stations.map((s) => s.cc).filter(Boolean)).size;
    $('statGeo').textContent = state.geoStations.length.toLocaleString();
  }
  function renderList() {
    const all = getFiltered();
    const sorted = getSorted(all);
    const shown = sorted.slice(0, state.visibleCount);
    $('stationGrid').innerHTML = shown.map(cardHTML).join('');
    $('listEmpty').hidden = shown.length !== 0;
    const localMore = state.visibleCount < sorted.length;
    const moreAvailable = state.query ? state.searchHasMore : state.hasMore;
    $('loadMore').hidden = localMore ? false : !moreAvailable;
    $('loadMore').textContent = localMore ? '显示更多已载入电台' : '从全球目录加载更多电台';
    $('listTitle').textContent = state.favoritesOnly
      ? '我的收藏'
      : (state.query ? '搜索结果'
        : (state.country ? (state.countryName || '国家筛选')
          : (state.genre ? (GENRE_LABELS[state.genre] || state.genre) : '全球电台')));
  }
  function cardHTML(s) {
    const isCurrent = state.current && state.current.id === s.id;
    const isFav = state.favorites.has(s.id);
    const tags = s.tags.slice(0, 2).map((t) => '<span>' + esc(GENRE_LABELS[t.toLowerCase()] || t) + '</span>').join('');
    return '<article class="station-card' + (isCurrent ? ' is-current' : '') + (isCurrent && state.playing ? ' is-playing' : '') + '" data-id="' + esc(s.id) + '">'
      + '<div class="card-logo">' + logoHTML(s) + '</div>'
      + '<div class="card-body">'
      + '<div class="card-name" title="' + esc(s.name) + '">' + esc(s.name) + '</div>'
      + '<div class="card-sub"><span class="card-flag">' + flagEmoji(s.cc) + '</span>'
      + '<span>' + esc(countryLabel(s.cc, s.country)) + '</span>'
      + (s.bitrate ? '<span>· ' + s.bitrate + 'k</span>' : '') + '</div>'
      + '<div class="card-tags">' + tags + '</div>'
      + '</div>'
      + '<button class="card-play" type="button" aria-label="播放 ' + esc(s.name) + '"><svg viewBox="0 0 24 24"><path d="m8 5 11 7-11 7Z"/></svg></button>'
      + '<button class="card-fav' + (isFav ? ' is-fav' : '') + '" type="button" aria-label="收藏"><svg viewBox="0 0 24 24"><path d="M12 20.3 4.5 13a4.6 4.6 0 0 1 6.5-6.5l1 1 1-1a4.6 4.6 0 0 1 6.5 6.5Z"/></svg></button>'
      + '</article>';
  }
  function renderSuggestions() {
    const box = $('suggest');
    if (!state.query.trim()) { box.hidden = true; box.innerHTML = ''; return; }
    const items = getFiltered().slice(0, 6);
    if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = items.map((s) => '<button class="suggest-item" type="button" data-id="' + esc(s.id) + '">'
      + logoHTML(s) + '<span class="s-name">' + esc(s.name) + '</span>'
      + '<span class="s-country">' + flagEmoji(s.cc) + ' ' + esc(countryLabel(s.cc, s.country)) + '</span></button>').join('');
    box.hidden = false;
  }
  function updateSpotlight(s) {
    if (!s) {
      $('spotlightEmpty').hidden = false;
      $('spotlightDetail').hidden = true;
      return;
    }
    $('spotlightEmpty').hidden = true;
    $('spotlightDetail').hidden = false;
    $('detailLogo').innerHTML = logoHTML(s);
    $('detailName').textContent = s.name;
    $('detailPlace').textContent = [flagEmoji(s.cc), countryLabel(s.cc, s.country), s.region].filter(Boolean).join(' · ');
    $('detailTags').innerHTML = s.tags.slice(0, 5).map((t) => '<span>' + esc(GENRE_LABELS[t.toLowerCase()] || t) + '</span>').join('');
    const playing = state.current && state.current.id === s.id && state.playing;
    $('detailPlay').querySelector('span').textContent = playing ? '暂停播放' : '开始收听';
    $('detailFav').classList.toggle('is-fav', state.favorites.has(s.id));
    const meta = [
      ['语言', s.lang || '—'],
      ['音质', s.bitrate ? s.bitrate + ' kbps · ' + (s.codec || '—') : (s.codec || '—')],
      ['坐标', Number.isFinite(s.lat) ? s.lat.toFixed(2) + '°, ' + s.lng.toFixed(2) + '°' : '—'],
      ['热度', s.votes.toLocaleString() + ' 票']
    ];
    $('detailMeta').innerHTML = meta.map((row) => '<div><dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd></div>').join('');
    if (s.homepage && /^https?:\/\//i.test(s.homepage)) {
      $('detailHome').href = s.homepage;
      $('detailHome').hidden = false;
    } else {
      $('detailHome').hidden = true;
    }
  }
  function updateFavoriteUI() {
    $('favCount').textContent = state.favorites.size;
    $('favBtn').setAttribute('aria-pressed', String(state.favoritesOnly));
    const cur = state.current;
    $('playerFav').disabled = !cur;
    $('playerFav').classList.toggle('is-fav', !!cur && state.favorites.has(cur.id));
    $('detailFav').classList.toggle('is-fav', !!cur && state.favorites.has(cur.id));
    document.querySelectorAll('.station-card').forEach((card) => {
      const btn = card.querySelector('.card-fav');
      if (btn) btn.classList.toggle('is-fav', state.favorites.has(card.dataset.id));
    });
  }

  /* ---------------- 播放器 ---------------- */
  function selectStation(s) {
    $('spotlightDetail').dataset.id = s.id;
    updateSpotlight(s);
    updateGlobeData();
    document.querySelectorAll('.station-card').forEach((c) => c.classList.toggle('is-current', c.dataset.id === s.id));
  }
  function play(s) {
    if (!s) return;
    if (!s.url) { toast('该电台暂未提供可用流地址', true); return; }
    if (state.current && state.current.id === s.id) {
      if (state.playing) { audio.pause(); return; }
      audio.play().catch((e) => handlePlayError(e));
      return;
    }
    state.current = s;
    selectStation(s);
    updatePlayerTrack();
    audio.src = s.url;
    audio.volume = state.volume;
    state.loading = true;
    updatePlayState();
    audio.play().catch((e) => handlePlayError(e));
  }
  function handlePlayError(err) {
    state.loading = false;
    state.playing = false;
    updatePlayState();
    const msg = err && err.name === 'NotSupportedError'
      ? '浏览器不支持该电台的音频格式'
      : (err && err.name === 'NotAllowedError' ? '浏览器阻止了自动播放，请再次点击' : '电台暂时无法连接，请换一个试试');
    toast(msg, true);
  }
  function updatePlayerTrack() {
    const s = state.current;
    $('playBtn').disabled = false;
    if (!s) return;
    $('trackArt').innerHTML = logoHTML(s);
    $('trackName').textContent = s.name;
    $('trackSub').textContent = [flagEmoji(s.cc), countryLabel(s.cc, s.country), s.tags[0] && GENRE_LABELS[s.tags[0].toLowerCase()] || s.tags[0]].filter(Boolean).join(' · ');
    $('player').classList.add('is-live');
    updateFavoriteUI();
  }
  function updatePlayState() {
    const btn = $('playBtn');
    btn.classList.toggle('is-playing', state.playing);
    btn.classList.toggle('is-loading', state.loading && !state.playing);
    btn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
    $('player').classList.toggle('is-live', state.playing);
    document.querySelectorAll('.station-card').forEach((c) => {
      c.classList.toggle('is-playing', !!(state.current && c.dataset.id === state.current.id && state.playing));
    });
    const detail = $('spotlightDetail');
    if (!detail.hidden && detail.dataset.id) {
      const s = state.stations.find((x) => x.id === detail.dataset.id);
      if (s) {
        $('detailPlay').querySelector('span').textContent =
          (state.current && state.current.id === s.id && state.playing) ? '暂停播放' : '开始收听';
      }
    }
  }
  function step(dir) {
    const list = getFiltered();
    if (!list.length) { toast('当前列表中没有电台', true); return; }
    const idx = list.findIndex((s) => state.current && s.id === state.current.id);
    const next = list[(idx + dir + list.length) % list.length];
    play(next);
  }

  /* ---------------- 视图与交互 ---------------- */
  function setView(view) {
    state.view = view;
    $('globeView').classList.toggle('is-active', view === 'globe');
    $('listView').classList.toggle('is-active', view === 'list');
    document.querySelectorAll('.view-switch button').forEach((b) => {
      const active = b.dataset.view === view;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    if (view === 'globe') {
      if (state.mapMode === '2d' && flatMap) flatMap.resize();
      else if (globeReady && globe) {
        const el = $('globeContainer');
        globe.width(el.clientWidth);
        globe.height(el.clientHeight);
      }
    } else {
      // 进入列表后立即检查一次，补齐首屏可见数量
      if (typeof state.pokeScroll === 'function') setTimeout(state.pokeScroll, 60);
    }
  }
  function toggleFav(id) {
    const s = state.stations.find((x) => x.id === id);
    if (!s) return;
    if (state.favorites.has(id)) {
      state.favorites.delete(id);
      toast('已取消收藏');
    } else {
      state.favorites.add(id);
      toast('已加入收藏');
    }
    saveJSON('aether:favorites', Array.from(state.favorites));
    updateFavoriteUI();
    if (state.favoritesOnly) { updateGlobeData(); renderList(); }
  }
  function wireEvents() {
    // 视图切换
    document.querySelectorAll('.view-switch button').forEach((b) =>
      b.addEventListener('click', () => setView(b.dataset.view)));

    // 风格筛选
    $('genreChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.genre = chip.dataset.genre || '';
      state.visibleCount = 30;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('is-active', c === chip));
      updateGlobeData();
      renderList();
      updateResultMeta();
      supplementFilter();
    });

    // 内置目录下重试联网
    $('resultMeta').addEventListener('click', (e) => {
      if (e.target.closest('.retry-link')) retryConnection();
    });

    // 收藏筛选
    $('favBtn').addEventListener('click', () => {
      state.favoritesOnly = !state.favoritesOnly;
      state.visibleCount = 30;
      updateFavoriteUI();
      updateGlobeData();
      renderList();
      updateResultMeta();
    });

    // 搜索
    const input = $('searchInput');
    input.addEventListener('input', () => {
      state.query = input.value.trim();
      state.visibleCount = 30;
      state.searchOffset = 0;
      $('searchClear').hidden = !input.value;
      $('searchKbd').hidden = !!input.value;
      renderSuggestions();
      updateGlobeData();
      renderList();
      updateResultMeta();
      clearTimeout(searchTimer);
      if (state.query.length >= 2) searchTimer = setTimeout(supplementFilter, 480);
    });
    input.addEventListener('focus', renderSuggestions);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = $('suggest').querySelector('.suggest-item');
        if (first && !$('suggest').hidden) { first.click(); }
        $('suggest').hidden = true;
        input.blur();
      }
      if (e.key === 'Escape') { $('suggest').hidden = true; input.blur(); }
    });
    $('searchClear').addEventListener('click', () => {
      input.value = '';
      state.query = '';
      $('searchClear').hidden = true;
      $('searchKbd').hidden = false;
      $('suggest').hidden = true;
      updateGlobeData();
      renderList();
      input.focus();
    });
    $('suggest').addEventListener('click', (e) => {
      const item = e.target.closest('.suggest-item');
      if (!item) return;
      const s = state.stations.find((x) => x.id === item.dataset.id);
      if (s) { play(s); focusGlobe(s); }
      $('suggest').hidden = true;
    });
    document.addEventListener('pointerdown', (e) => {
      if (!$('searchWrap').contains(e.target)) $('suggest').hidden = true;
    });

    // 列表卡片（事件委托）
    $('stationGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.station-card');
      if (!card) return;
      const s = state.stations.find((x) => x.id === card.dataset.id);
      if (!s) return;
      if (e.target.closest('.card-fav')) { toggleFav(s.id); return; }
      play(s);
    });

    // 聚光灯面板
    $('detailPlay').addEventListener('click', () => {
      const id = $('spotlightDetail').dataset.id;
      const s = state.stations.find((x) => x.id === id);
      if (s) play(s);
    });
    $('detailFav').addEventListener('click', () => {
      const id = $('spotlightDetail').dataset.id;
      if (id) toggleFav(id);
    });
    $('detailClose').addEventListener('click', () => {
      $('spotlightDetail').hidden = true;
      $('spotlightEmpty').hidden = false;
    });

    // 国家筛选
    $('countrySelect').addEventListener('change', (e) => {
      const opt = e.target.selectedOptions[0];
      state.country = e.target.value;
      state.countryName = state.country
        ? opt.textContent.replace(/\s*·\s*\d+$/, '').trim()
        : '';
      state.visibleCount = 30;
      updateGlobeData();
      renderList();
      updateResultMeta();
      supplementFilter();
    });

    // 加载更多 / 排序
    $('loadMore').addEventListener('click', () => {
      if (state.visibleCount < getSorted(getFiltered()).length) {
        state.visibleCount += 120;
        renderList();
      } else {
        loadMoreStations();
      }
    });

    // 无限滚动：接近底部时先展开已载入内容，再自动向目录取下一批。
    // 用滚动位置判断而非 IntersectionObserver，切换视图后也能立即生效。
    let scrollTick = false;
    const onListScroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        scrollTick = false;
        if (state.view !== 'list' || state.loadingMore) return;
        const btn = $('loadMore');
        if (btn.hidden) return;
        if (btn.getBoundingClientRect().top > window.innerHeight + 320) return;
        const sorted = getSorted(getFiltered());
        if (state.visibleCount < sorted.length) {
          state.visibleCount += 120;
          renderList();
          return;
        }
        // 仅在未筛选时自动翻页，避免筛选结果为空时反复请求
        const unfiltered = !state.query && !state.genre && !state.country && !state.favoritesOnly;
        if (unfiltered && state.hasMore && Date.now() - autoLoadAt > 1200) {
          autoLoadAt = Date.now();
          loadMoreStations();
        }
      });
    };
    state.pokeScroll = onListScroll;
    document.addEventListener('scroll', onListScroll, { capture: true, passive: true });
    $('sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

    // 播放器
    $('playBtn').addEventListener('click', () => {
      if (!state.current) {
        const first = getSorted(getFiltered())[0];
        if (first) play(first); else toast('请先选择一个电台');
        return;
      }
      if (state.playing) audio.pause();
      else audio.play().catch((e) => handlePlayError(e));
    });
    $('prevBtn').addEventListener('click', () => step(-1));
    $('nextBtn').addEventListener('click', () => step(1));
    $('playerFav').addEventListener('click', () => { if (state.current) toggleFav(state.current.id); });
    $('volume').addEventListener('input', (e) => {
      state.volume = Number(e.target.value);
      audio.volume = state.volume;
      $('volNum').textContent = Math.round(state.volume * 100);
      saveJSON('aether:volume', state.volume);
    });
    $('resetGlobe').addEventListener('click', () => {
      if (state.mapMode === '2d') { if (flatMap) flatMap.reset(); return; }
      if (!globeReady || !globe) return;
      globe.pointOfView({ lat: 20, lng: 12, altitude: window.innerWidth < 760 ? 2.7 : 2.1 }, 900);
    });
    $('mapModeSwitch').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.mode === '3d' && !globeReady) {
        toast('当前浏览器无法运行 3D 地球', true);
        return;
      }
      setMapMode(btn.dataset.mode);
    });
    $('globeGuide').addEventListener('click', () => { $('globeGuide').classList.add('is-hidden'); });

    // 音频事件
    audio.addEventListener('playing', () => { state.playing = true; state.loading = false; updatePlayState(); });
    audio.addEventListener('waiting', () => { state.loading = true; updatePlayState(); });
    audio.addEventListener('pause', () => { state.playing = false; state.loading = false; updatePlayState(); });
    audio.addEventListener('error', () => {
      if (!state.current) return;
      state.playing = false;
      state.loading = false;
      updatePlayState();
      toast('电台信号中断，请尝试其他电台', true);
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); }
      if (e.key === 'Escape' && !typing) {
        $('spotlightDetail').hidden = true;
        $('spotlightEmpty').hidden = false;
      }
      if (e.code === 'Space' && !typing && state.current) {
        e.preventDefault();
        $('playBtn').click();
      }
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    state.codecSupport = buildCodecSupport();
    $('volume').value = state.volume;
    $('volNum').textContent = Math.round(state.volume * 100);
    audio.volume = state.volume;
    updateFavoriteUI();
    if (window.matchMedia('(pointer: coarse)').matches) {
      $('globeGuide').lastChild.textContent = ' 拖动旋转 · 双指缩放 · 点击光点收听';
    }
    wireEvents();
    initGlobe();
    await loadStations();
    setTimeout(() => $('boot').classList.add('is-done'), 260);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
