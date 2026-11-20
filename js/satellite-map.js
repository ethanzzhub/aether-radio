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
        layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }]
      },
      center: [12, 30],
      zoom: 1.6,
      attributionControl: false,
      dragRotate: false
    });

    let ready = false;
    let tileErrors = 0;
    let tileLoads = 0;
    const mapEl = map.getContainer();
    mapEl.classList.add('aether-satellite');
    mapEl.style.display = 'none';   // 默认隐藏，切到卫星模式才显示

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
            0, 2, 1000, 2.8, 10000, 3.8, 100000, 6
          ],
          'circle-color': [
            'match', ['get', 'src'],
            'country', 'rgba(200,196,186,0.72)',
            'admin1', 'rgba(226,190,128,0.85)',
            'city', 'rgba(244,206,132,0.92)',
            '#ffd98a'
          ],
          'circle-stroke-width': 0.6,
          'circle-stroke-color': 'rgba(60,40,12,0.35)',
          'circle-opacity': 0.95
        }
      });
      // 当前播放台：外圈高亮
      map.addSource('current', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      map.addLayer({
        id: 'current-ring',
        type: 'circle',
        source: 'current',
        paint: {
          'circle-radius': 12,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ff7a45'
        }
      });

      map.on('click', 'stations-pts', function (e) {
        const f = e.features && e.features[0];
        if (!f) return;
        const s = getStations().find(function (x) { return x.id === f.properties.id; });
        if (s) onSelect(s);
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
      const curFeatures = cur && Number.isFinite(cur.lat) && Number.isFinite(cur.lng)
        ? [toFeature(cur)] : [];
      map.getSource('current').setData({ type: 'FeatureCollection', features: curFeatures });
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
