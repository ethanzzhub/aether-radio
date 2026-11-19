/* ============================================================
   AETHER · 2D 备用地图
   当浏览器不支持 WebGL 时，用 Canvas 绘制等距圆柱投影世界地图。
   无需任何外部依赖，支持缩放、拖拽、点击电台、热度着色。
   ============================================================ */
(function () {
  'use strict';

  window.FlatMap = function (options) {
    const container = options.container;
    const getStations = options.getStations;
    const onSelect = options.onSelect;
    const getCurrent = options.getCurrent;
    const heatColor = options.heatColor;

    const canvas = document.createElement('canvas');
    canvas.id = 'flatMap';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0, dpr = 1;
    let scale = 1, offsetX = 0, offsetY = 0;
    let points = [];
    let hovered = null;
    let dragging = false, moved = false;
    let lastX = 0, lastY = 0;
    let animFrame = null;

    // 等距圆柱投影：经度 [-180,180] → [0,1]，纬度 [85,-85] → [0,1]
    function project(lng, lat) {
      const nx = (lng + 180) / 360;
      const ny = (85 - Math.max(-85, Math.min(85, lat))) / 170;
      const baseW = W;
      const baseH = Math.min(H, baseW / 2.05);
      return {
        x: nx * baseW * scale + offsetX,
        y: ny * baseH * scale + offsetY + (H - baseH * scale) / 2
      };
    }

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = container.clientWidth || 800;
      H = container.clientHeight || 600;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function drawLand() {
      const land = window.WORLD_LAND || [];
      ctx.fillStyle = 'rgba(212, 206, 192, 0.92)';
      ctx.strokeStyle = 'rgba(146, 152, 142, 0.6)';
      ctx.lineWidth = 0.6;
      for (const poly of land) {
        for (const ring of poly) {
          if (ring.length < 3) continue;
          ctx.beginPath();
          for (let i = 0; i < ring.length; i++) {
            const p = project(ring[i][0], ring[i][1]);
            if (i === 0) ctx.moveTo(p.x, p.y);
            else ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    function drawGraticule() {
      ctx.strokeStyle = 'rgba(120, 132, 126, 0.16)';
      ctx.lineWidth = 0.5;
      for (let lng = -180; lng <= 180; lng += 30) {
        const a = project(lng, 85), b = project(lng, -85);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const a = project(-180, lat), b = project(180, lat);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      // 浅色海洋底
      ctx.fillStyle = 'rgba(238, 242, 243, 0.9)';
      ctx.fillRect(0, 0, W, H);
      drawGraticule();
      drawLand();

      const current = getCurrent();
      const pts = getStations().filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng));
      points = [];
      for (const s of pts) {
        const p = project(s.lng, s.lat);
        if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;
        const isCur = current && s.id === current.id;
        const r = isCur ? 5.5 : (hovered && hovered.id === s.id ? 5 : 2.6);
        points.push({ x: p.x, y: p.y, r: r, station: s });
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = heatColor(s.votes, isCur);
        ctx.fill();
        if (isCur) {
          ctx.strokeStyle = 'rgba(176,58,18,0.9)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // 播放地的脉冲环
      if (current && Number.isFinite(current.lat)) {
        const p = project(current.lng, current.lat);
        const t = (Date.now() % 1800) / 1800;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + t * 22, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(176,58,18,' + (1 - t) * 0.65 + ')';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    function loop() {
      draw();
      animFrame = requestAnimationFrame(loop);
    }

    function nearest(x, y) {
      let best = null, bestD = 14;
      for (const p of points) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    }
    function localPos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        offsetX += dx; offsetY += dy;
        lastX = e.clientX; lastY = e.clientY;
        draw();
      } else {
        const pos = localPos(e);
        const hit = nearest(pos.x, pos.y);
        const id = hit ? hit.station.id : null;
        if ((hovered && hovered.id) !== id) {
          hovered = hit ? hit.station : null;
          draw();
        }
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      if (!moved) {
        const pos = localPos(e);
        const hit = nearest(pos.x, pos.y);
        if (hit) onSelect(hit.station);
      }
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    });
    canvas.addEventListener('pointerleave', () => { hovered = null; draw(); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pos = localPos(e);
      const factor = e.deltaY < 0 ? 1.14 : 1 / 1.14;
      const next = Math.max(0.7, Math.min(8, scale * factor));
      const k = next / scale;
      offsetX = pos.x - (pos.x - offsetX) * k;
      offsetY = pos.y - (pos.y - offsetY) * k;
      scale = next;
      draw();
    }, { passive: false });

    function reset() { scale = 1; offsetX = 0; offsetY = 0; draw(); }
    function refresh() { draw(); }
    function show() { canvas.style.display = 'block'; if (!animFrame) loop(); resize(); }
    function hide() { canvas.style.display = 'none'; if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }

    return { show: show, hide: hide, reset: reset, refresh: refresh, resize: resize, canvas: canvas };
  };
})();
