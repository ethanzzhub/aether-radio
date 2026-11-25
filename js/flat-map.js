/* AETHER · Leaflet 2D 卫星地图，无需 WebGL。 */
(function () {
  'use strict';

  window.FlatMap = function (options) {
    const el = document.createElement('div');
    el.id = 'flatMap';
    options.container.appendChild(el);

    // 每级瓦片的基础像素尺寸随舞台宽度自适应：让世界地图在概览级别刚好
    // 铺满舞台（取宽高中较大者），左右不留空；极地附近几乎没有电台，
    // 纵向多出来的部分被裁掉。瓦片仍是整数级渲染，不会有小数缩放的缝隙。
    let baseTileSize = 256;
    let projectionDirty = false;
    const fitCRS = L.Util.extend({}, L.CRS.EPSG3857, {
      scale: function (zoom) { return baseTileSize * Math.pow(2, zoom); }
    });

    const map = L.map(el, {
      crs: fitCRS,
      preferCanvas: true,
      zoomControl: false,
      minZoom: 0,
      // 整数级缩放：fractional zoom 会让瓦片层被 CSS transform 重采样，
      // 相邻瓦片边缘露出半透明缝，在深底图上呈现横竖网格条。整数级按原生像素
      // 对齐可彻底消除缝隙；缩放动画本身保留，滚轮过渡依然平滑。
      zoomSnap: 1,
      zoomDelta: 1,
      wheelPxPerZoomLevel: 90,
      // 滚轮以地图中心缩放，不以光标为锚点——否则缩放时画面会朝光标方向平移，
      // 用户感觉"只是想缩小，画面却跑了"。
      scrollWheelZoom: 'center',
      maxZoom: 19,
      maxBounds: [[-85.05112878, -180], [85.05112878, 180]],
      maxBoundsViscosity: 1
    }).setView([0, 0], 2);

    // 概览视野：世界宽度铺满舞台，纵向裁掉电台稀少的极地；中心落在全部
    // 电台的地理范围中心，因此经度方向仍能看到所有电台，左右不留空白。
    const WORLD_BOUNDS = [[-85.05112878, -180], [85.05112878, 180]];
    let overviewCenter = [20, 0];
    let overviewZoom = 2;
    let viewInitialized = false;

    function computeOverview() {
      const size = map.getSize();
      if (!size.x || !size.y) return;
      const all = options.getAllStations ? options.getAllStations() : options.getStations();
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, n = 0;
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
        minLat = Math.min(minLat, s.lat);
        maxLat = Math.max(maxLat, s.lat);
        minLng = Math.min(minLng, s.lng);
        maxLng = Math.max(maxLng, s.lng);
        n++;
      }
      // 数据尚未就绪时退回全球范围；首屏数据到达后 refresh() 会重算中心。
      const bounds = L.latLngBounds(n ? [[minLat, minLng], [maxLat, maxLng]] : WORLD_BOUNDS);

      // 让基础瓦片尺寸贴近原生 256px：太大则影像发虚，太小则缩放级数过低。
      const span = Math.max(size.x, size.y);
      const z = Math.max(0, Math.min(6, Math.round(Math.log2(span / 256))));
      const base = Math.max(64, Math.round(span / Math.pow(2, z)));
      if (base !== baseTileSize) {
        baseTileSize = base;
        projectionDirty = true;
      }
      overviewZoom = z;
      const sw = map.project(bounds.getSouthWest(), overviewZoom);
      const ne = map.project(bounds.getNorthEast(), overviewZoom);
      overviewCenter = map.unproject(sw.add(ne).divideBy(2), overviewZoom);
      map.setMinZoom(overviewZoom);
    }

    // 基础瓦片尺寸变化后，投影缓存与已加载瓦片都要重建，否则会整层错位。
    function applyProjection() {
      if (!projectionDirty) return;
      projectionDirty = false;
      imagery.options.tileSize = baseTileSize;
      map._resetView(map.getCenter(), map.getZoom(), true);
      imagery.redraw();
    }

    function syncNavigation() {
      const atMinimum = map.getZoom() <= map.getMinZoom() + 0.001;
      if (atMinimum) {
        map.dragging.disable();
        map.keyboard.disable();
        map.setView(overviewCenter, overviewZoom, { animate: false });
      } else {
        map.dragging.enable();
        map.keyboard.enable();
      }
      el.classList.toggle('is-locked', atMinimum);
    }
    map.on('zoomend', syncNavigation);
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);

    // 本地陆地轮廓打底：在线瓦片不可用（网络受限）或尚未就绪时仍有地理参照，
    // 观感也与暗色地球一致——深墨绿陆地 + 极淡绿色海岸线。
    if (window.WORLD_LAND) {
      map.createPane('landbase');
      const pane = map.getPane('landbase');
      pane.style.zIndex = 150;
      pane.style.pointerEvents = 'none';
      L.geoJSON(
        { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: window.WORLD_LAND } },
        {
          pane: 'landbase',
          interactive: false,
          style: {
            color: 'rgba(61, 220, 132, .22)',
            weight: 0.7,
            fillColor: '#17241f',
            fillOpacity: 1
          }
        }
      ).addTo(map);
    }

    const imagery = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        tileSize: baseTileSize,
        noWrap: true,
        maxNativeZoom: 19,
        maxZoom: 19,
        attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics'
      }
    ).addTo(map);
    let errors = 0;
    let warned = false;
    imagery.on('tileload', function () { errors = 0; });
    imagery.on('tileerror', function () {
      if (++errors >= 6 && !warned) {
        warned = true;
        if (options.onStatus) options.onStatus('tile-error', '2D 卫星影像加载失败，请检查网络');
      }
    });
    const renderer = L.canvas({ padding: 0.3 });
    const markers = L.layerGroup().addTo(map);
    const currentLayer = L.layerGroup().addTo(map);
    let visible = true;
    let stationList = [];

    // 建点只做一次：每次选中电台都重建 3 万个 circleMarker（还各带一个 Tooltip）
    // 会让点击卡住好几秒，所以这里按数据签名判重，选中变化只挪呼吸圈。
    let lastSig = null;
    function sigOf(list) {
      let h = list.length;
      const step = Math.max(1, Math.floor(list.length / 16));
      for (let i = 0; i < list.length; i += step) {
        const id = list[i].id || '';
        for (let k = 0; k < id.length; k += 3) h = (h * 33 + id.charCodeAt(k)) | 0;
      }
      return h;
    }

    function buildMarkers(list) {
      markers.clearLayers();
      stationList = [];
      for (let i = 0; i < list.length; i++) {
        const station = list[i];
        if (!Number.isFinite(station.lat) || !Number.isFinite(station.lng)) continue;
        const estimated = station.geoSource && station.geoSource !== 'original';
        const marker = L.circleMarker([station.lat, station.lng], {
          renderer: renderer,
          radius: (1 + Math.min(1.1, Math.log10(1 + Math.max(0, station.votes || 0)) * 0.3)) * (estimated ? 0.8 : 1),
          // 不描边：小尺寸下哪怕 0.7px 的暗边也会把点压成「带圈的图钉」
          color: '#18e87e',
          weight: 0,
          fillColor: estimated ? '#14d878' : '#18e87e',
          fillOpacity: estimated ? 0.95 : 1
        });
        const label = document.createElement('span');
        label.textContent = station.name + (estimated ? ' · 位置估算' : '');
        marker.bindTooltip(label, { direction: 'top' });
        marker.addTo(markers);
        stationList.push(station);
      }
    }

    // 选中台：一个 DOM 水波纹（CSS 动画，不逐帧重绘 canvas）
    function syncCurrent() {
      currentLayer.clearLayers();
      const current = options.getCurrent();
      if (current && Number.isFinite(current.lat) && Number.isFinite(current.lng)) {
        L.marker([current.lat, current.lng], {
          icon: L.divIcon({
            className: 'beacon-div',
            html: '<div class="beacon"><i class="beacon-ping"></i><i class="beacon-ping"></i><i class="beacon-ping"></i><i class="beacon-core"></i></div>',
            iconSize: [0, 0],
            iconAnchor: [0, 0]
          }),
          interactive: false,
          keyboard: false,
          zIndexOffset: 900
        }).addTo(currentLayer);
      }
    }

    function refresh() {
      const list = options.getStations();
      const sig = sigOf(list);
      if (sig !== lastSig) {
        const wasAtMinimum = map.getZoom() <= map.getMinZoom() + 0.001;
        buildMarkers(list);
        lastSig = sig;
        computeOverview();
        applyProjection();
        // 仅在用户还停在概览视野时跟随数据更新；已放大时不打断当前位置
        if (wasAtMinimum && viewInitialized) {
          map.setView(overviewCenter, overviewZoom, { animate: false });
          syncNavigation();
        }
      }
      syncCurrent();
    }
    // 点击/悬停拾取：在 12px 内找离光标最近的电台，而不是要求正好点在 1–2px 的圆点上
    const PICK_PX = 12;
    function pickAt(origin) {
      if (!stationList.length) return null;
      const bounds = map.getBounds().pad(0.05);
      let best = null;
      let bestD = PICK_PX * PICK_PX;
      for (let i = 0; i < stationList.length; i++) {
        const s = stationList[i];
        if (!bounds.contains([s.lat, s.lng])) continue;
        const p = map.latLngToContainerPoint([s.lat, s.lng]);
        const dx = p.x - origin.x;
        const dy = p.y - origin.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = s; }
      }
      return best;
    }
    let hoverRaf = 0;
    let hoverPt = null;
    map.on('mousemove', function (e) {
      hoverPt = e.containerPoint;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(function () {
        hoverRaf = 0;
        if (!hoverPt) return;
        el.style.cursor = pickAt(hoverPt) ? 'pointer' : '';
      });
    });
    map.on('mouseout', function () { el.style.cursor = ''; });
    map.on('click', function (e) {
      const best = pickAt(e.containerPoint || map.mouseEventToContainerPoint(e.originalEvent));
      // 推迟一帧再切台：不要在 Leaflet 的事件派发栈里重建图层
      if (best) setTimeout(function () { options.onSelect(best); }, 0);
    });

    function resize() {
      if (!visible) return;
      map.invalidateSize({ pan: false });
      const size = map.getSize();
      if (!size.x || !size.y) return;
      const wasAtMinimum = map.getZoom() <= map.getMinZoom() + 0.001;
      computeOverview();
      applyProjection();
      if (wasAtMinimum || !viewInitialized) {
        map.setView(overviewCenter, overviewZoom, { animate: false });
        viewInitialized = true;
      }
      syncNavigation();
    }
    resize();
    return {
      map: map,
      show: function () { visible = true; el.style.display = 'block'; resize(); },
      hide: function () { visible = false; el.style.display = 'none'; },
      reset: function () { map.setView(overviewCenter, overviewZoom); },
      focus: function (station) {
        if (station && Number.isFinite(station.lat) && Number.isFinite(station.lng)) {
          map.setView([station.lat, station.lng], Math.max(12, map.getZoom()));
        }
      },
      refresh: refresh,
      resize: resize
    };
  };
})();
