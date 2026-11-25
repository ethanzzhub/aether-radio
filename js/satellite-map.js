/* ============================================================
   AETHER · 卫星地球（MapLibre 5.x globe + Esri World Imagery）
   与 radio.garden 同款做法：MapLibre 负责 globe 投影与瓦片，
   影像源用免费无需 key 的 Esri World Imagery。可无缝放大到城市街道级。
   电台以 GeoJSON circle 图层呈现，点击点位回调 onSelect。
   ============================================================ */
(function () {
  'use strict';

  window.SatelliteMap = function (options) {
    const container = options.container;
    const getStations = options.getStations;
    const getCurrent = options.getCurrent;
    const onSelect = options.onSelect;
    const onStatus = options.onStatus || function () {};

    if (typeof window.maplibregl !== 'object') {
      onStatus('unavailable', '地图组件未加载');
      return null;
    }

    const map = new window.maplibregl.Map({
      container: container,
      style: {
        version: 8,
        // 直接在 style 里声明 globe，避免 setProjection 触发 style 重载把后续图层清空
        projection: { type: 'globe' },
        sources: {
          satellite: {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            attribution: 'Imagery © Esri, Maxar, Earthstar Geographics'
          }
        },
        // 底图只压暗 raster 层，绿点图层不受影响
        layers: [{
          id: 'satellite',
          type: 'raster',
          source: 'satellite',
          paint: {
            // 保留影像本来色彩：之前压到 46% 亮度、去饱和 -62%，
            // 整块地图像蒙了一层灰膜
            'raster-brightness-max': 0.92,
            'raster-saturation': 0.12,
            'raster-contrast': 0.06,
            'raster-hue-rotate': 0
          }
        }]
      },
      center: [12, 30],
      zoom: 1.6,
      attributionControl: false,
      dragRotate: false,
      // 关闭内置滚轮缩放：MapLibre 默认以光标为锚点，缩放时中心会朝光标漂移，
      // 看起来像"只是缩小画面，画面却移动了"。改用下面以视图中心缩放的处理。
      scrollZoom: false
    });

    let ready = false;
    let tileErrors = 0;
    let tileLoads = 0;
    const mapEl = map.getContainer();
    mapEl.classList.add('aether-satellite');
    mapEl.style.display = 'none';   // 默认隐藏，切到卫星模式才显示

    // 以视图中心缩放：只改变 zoom，不动 center。速率对齐 MapLibre 内置手感
    // （约 100px 一档），并按 deltaMode 归一化行/页滚动与像素滚动的差异。
    mapEl.addEventListener('wheel', function (e) {
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 40;
      else if (e.deltaMode === 2) d *= 800;
      const z = map.getZoom() - d / 100;
      map.easeTo({
        zoom: Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), z)),
        duration: 0
      });
    }, { passive: false });

    map.on('load', function () {
      ready = true;
      addStationLayers();
      refresh();
      onStatus('ready', '');
    });
    // MapLibre 在某些时序下会重载 style（尤其容器由隐藏转可见时），
    // 重载会清掉自定义 source/layer，这里在 style 数据变化后幂等补加。
    map.on('styledata', function () {
      if (!ready) return;
      if (!map.getSource('stations')) {
        addStationLayers();
        refresh();
      }
    });
    map.on('error', function (e) {
      // 瓦片级错误很常见（个别区块缺失），仅在全部失败时上报
      if (e && e.error && /tile|fetch|network/i.test(String(e.error.message))) {
        tileErrors += 1;
        if (tileLoads === 0 && tileErrors > 6) onStatus('tile-error', '卫星瓦片加载失败，请检查网络');
      }
    });
    map.on('data', function (e) {
      if (e.dataType === 'source' && e.sourceId === 'satellite') tileLoads += 1;
    });

    function toFeature(s) {
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: {
          id: s.id,
          name: s.name,
          votes: s.votes || 0,
          src: s.geoSource || 'original',
          cc: s.cc || '',
          country: s.country || '',
          tags: (s.tags || []).slice(0, 1).join(',')
        }
      };
    }

    // style 重载时序在「隐藏容器→显示」时不稳定，用轮询兜底确保点层最终一定加上
    const ensureTimer = setInterval(function () {
      if (ready && !map.getSource('stations')) {
        addStationLayers();
        refresh();
      }
    }, 500);

    let adding = false;
    let curMarker = null;
    function addStationLayers() {
      if (adding || map.getSource('stations')) return;
      adding = true;
      map.addSource('stations', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      // 普通电台点：热度越高越大越亮；推算坐标更淡更小
      map.addLayer({
        id: 'stations-pts',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-radius': [
            'interpolate', ['linear'], ['get', 'votes'],
            0, 0.8, 1000, 1, 10000, 1.4, 100000, 2.2
          ],
          'circle-color': [
            'match', ['get', 'src'],
            'country', 'rgba(24, 232, 126, 0.95)',
            'admin1', 'rgba(30, 240, 134, 0.97)',
            'city', 'rgba(44, 246, 146, 0.98)',
            '#18e87e'
          ],
          // 不描边，和 2D 视图保持一致
          'circle-stroke-width': 0,
          'circle-opacity': 0.98
        }
      });
      // 当前选中台的高亮改由 DOM 呼吸标记负责（见 refresh），
      // 避免在 MapLibre 里做逐帧动画

      // 点击拾取：以点击点为心取 12px 见方的 bbox 查询，再挑离光标最近的一个，
      // 不必正好点在 1–2px 的点上
      map.on('click', function (e) {
        const box = [[e.point.x - 12, e.point.y - 12], [e.point.x + 12, e.point.y + 12]];
        const feats = map.queryRenderedFeatures(box, { layers: ['stations-pts'] });
        if (!feats.length) return;
        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < feats.length; i++) {
          const p = map.project(feats[i].geometry.coordinates);
          const dx = p.x - e.point.x;
          const dy = p.y - e.point.y;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = feats[i]; }
        }
        if (!best) return;
        const s = getStations().find(function (x) { return x.id === best.properties.id; });
        if (s) setTimeout(function () { onSelect(s); }, 0);
      });
      map.on('mouseenter', 'stations-pts', function () { container.style.cursor = 'pointer'; });
      map.on('mouseleave', 'stations-pts', function () { container.style.cursor = ''; });
      adding = false;
    }

    function refresh() {
      if (!ready || !map.getSource('stations')) return;
      const list = getStations();
      const features = [];
      for (const s of list) {
        if (Number.isFinite(s.lat) && Number.isFinite(s.lng)) features.push(toFeature(s));
      }
      map.getSource('stations').setData({ type: 'FeatureCollection', features: features });
      const cur = getCurrent();
      if (cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lng)) {
        const pos = [cur.lng, cur.lat];
        if (!curMarker) {
          const el = document.createElement('div');
          el.className = 'beacon';
          el.innerHTML = '<i class="beacon-ping"></i><i class="beacon-ping"></i><i class="beacon-ping"></i><i class="beacon-core"></i>';
          curMarker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(pos).addTo(map);
        } else {
          curMarker.setLngLat(pos);
        }
      } else if (curMarker) {
        curMarker.remove();
        curMarker = null;
      }
    }

    function focus(s) {
      if (!ready || !s || !Number.isFinite(s.lat)) return;
      map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 11), duration: 1400, essential: true });
    }

    function resize() {
      try { map.resize(); } catch (_) { /* 容器未显示时忽略 */ }
    }

    return {
      map: map,
      show: function () { mapEl.style.display = ''; resize(); },
      hide: function () { mapEl.style.display = 'none'; },
      refresh: refresh,
      focus: focus,
      resize: resize,
      isReady: function () { return ready; }
    };
  };
})();
