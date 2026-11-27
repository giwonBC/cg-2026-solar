/* [개선] 관찰 지원 인터페이스
   사용자: 3D 조작에 익숙하지 않은 점검자가 여섯 장치의 표지와 두 구조 비교를
           적은 조작으로 빠짐없이 확인한다.

   기본 버전에서 기록한 불편           →  이 파일의 대응
   1. 트랙볼 회전으로 화면이 기울어짐   →  수평 유지 회전 (controls.js) + 지점 클릭 시 명판 정면으로 이동
   2. 원근 화면에서 O1 크기 비교 불가   →  O1 전면 / O2 오른쪽 측면 직교 뷰 + 모서리 기준선
   3. 확대하면 지금 어디인지 모름       →  오른쪽 아래 전체 지도(현재 위치 표시) + 진행 상태 표시

   구성
   A. 지점별 카메라 계산   poiView / orthoView
   B. 부드러운 이동        flyTo / step
   C. 화면 그리기          render (본 화면 + 전체 지도) / drawOverlay (기준선·표시)
   D. 패널 UI              목록 클릭 · 이전/다음 · 전체 보기 · 확인 완료 체크 */
(() => {
  'use strict';
  const viewer = window.InspectionViewer;
  if (!viewer) return;
  const { canvas, model, controls } = viewer;
  const S = controls.state;
  const tasks = model.tasks;                         // P1~P6, O1, O2 (8건)

  const add = (a, b) => a.map((v, i) => v + b[i]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const scale = (a, k) => a.map(v => v * k);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const normalize = v => { const n = Math.hypot(...v) || 1; return v.map(x => x / n); };
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapAngle = a => Math.atan2(Math.sin(a), Math.cos(a));   // -π ~ π
  const tanHalf = () => Math.tan(S.fov * Math.PI / 360);

  /* ───────────────────────── A. 지점별 카메라 계산 ───────────────────────── */

  // 명판이 화면 높이의 16%, 화면 폭의 35%를 넘지 않는 거리.
  // 시야 높이 = 2·거리·tan(FOV/2) 이므로  거리 = (대상 크기 / 비율) / (2·tan(FOV/2))
  const SIGN_HEIGHT_RATIO = 0.16, SIGN_WIDTH_RATIO = 0.35;

  function poiView(p) {
    const aspect = canvas.width / canvas.height;
    const t2 = 2 * tanHalf();
    const byHeight = (p.size[1] / SIGN_HEIGHT_RATIO) / t2;
    const byWidth  = (p.size[0] / (SIGN_WIDTH_RATIO * aspect)) / t2;
    return {
      target: [...p.position],                       // 회전 중심 = 명판 중심
      distance: Math.max(byHeight, byWidth),
      yaw: p.yaw,                                    // 명판 앞면이 향하는 방향에서 바라본다
      pitch: -0.18,                                  // 약 10° 위에서 — 장치 윗면이 보여 맥락이 생긴다
      ortho: false,
    };
  }

  // 비교 대상(members) 상자들의 범위를 화면 가로·세로축으로 잰다.
  function memberBoxes(c) { return c.members.map(id => model.boxes.find(b => b.id === id)); }

  function orthoView(c) {
    // O1: +z 에서 -z 를 본다(yaw 0) → 화면 가로 = x
    // O2: +x 에서 -x 를 본다(yaw π/2) → 화면 가로 = z (+z 가 화면 왼쪽)
    const yaw = c.viewDirection[0] !== 0 ? Math.PI / 2 : 0;
    const right = yaw === 0 ? [1, 0, 0] : [0, 0, -1];
    let minR = Infinity, maxR = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const b of memberBoxes(c)) for (const sx of [-.5, .5]) for (const sy of [-.5, .5]) for (const sz of [-.5, .5]) {
      const corner = [b.position[0] + sx * b.size[0], b.position[1] + sy * b.size[1], b.position[2] + sz * b.size[2]];
      const r = dot(corner, right);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minY = Math.min(minY, corner[1]); maxY = Math.max(maxY, corner[1]);
    }
    const aspect = canvas.width / canvas.height;
    // 두 물체가 모두 들어오는 반높이 × 여백 1.5
    const half = 1.5 * Math.max((maxY - minY) / 2, (maxR - minR) / 2 / aspect);
    return {
      target: [...c.position],
      distance: half / tanHalf(),                    // 직교 반높이 = 거리 · tan(FOV/2) 로 휠 확대와 연결
      yaw, pitch: 0, ortho: true,
    };
  }

  function viewFor(i) {
    const item = tasks[i];
    return item.members ? orthoView(item) : poiView(item);
  }

  function homeView() {
    return { target: [3, 3, 0], distance: 30, yaw: .6, pitch: -.44, ortho: false };
  }

  /* ───────────────────────── B. 부드러운 이동 ───────────────────────── */

  const mode = { index: -1, ortho: false };          // index -1 = 전체 보기
  let anim = null;

  function flyTo(view, index) {
    mode.index = index;
    // 직교 뷰에서 나갈 때는 출발과 동시에 원근으로 바꾼다
    mode.ortho = false; S.lockRotation = false;
    const from = { target: [...S.target], distance: S.distance, yaw: S.yaw, pitch: S.pitch };
    const travel = Math.hypot(...sub(view.target, from.target));
    anim = { from, to: view, travel, t0: performance.now(), dur: 900 };
    S.actions++;                                     // 새 UI 조작도 기본 조작과 같은 기준으로 센다
    updatePanel();
  }

  function step(now) {
    if (!anim) return;
    const t = Math.min(1, (now - anim.t0) / anim.dur);
    const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;   // ease-in-out
    const { from, to } = anim;
    S.target = from.target.map((v, i) => lerp(v, to.target[i], e));
    S.yaw = from.yaw + wrapAngle(to.yaw - from.yaw) * e;              // 짧은 쪽으로 돈다
    S.pitch = lerp(from.pitch, to.pitch, e);
    // 거리는 로그로 보간하고, 멀리 이동할 때는 중간에 잠깐 물러나 전체 구조를 보여 준다
    // (건물 안을 뚫고 지나가는 느낌과 길 잃음을 줄인다)
    const d = Math.exp(lerp(Math.log(from.distance), Math.log(to.distance), e));
    S.distance = d + Math.sin(Math.PI * e) * anim.travel * 0.6;
    controls.sync();
    if (t >= 1) {
      anim = null;
      if (to.ortho) { mode.ortho = true; S.lockRotation = true; }
      updatePanel();
    }
  }

  // 사용자가 직접 드래그·휠·키를 쓰면 진행 중인 이동을 멈춘다
  S.onInput = kind => {
    anim = null;
    if (kind === 'home') goHome(false);
  };

  /* ───────────────────────── C. 화면 그리기 ───────────────────────── */

  // 겹쳐 그릴 2D 캔버스 (기준선, 대상 표시, 전체 지도 테두리)
  const overlay = document.createElement('canvas');
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  canvas.parentElement.appendChild(overlay);
  const ctx = overlay.getContext('2d');

  function mainCamera() {
    const cam = controls.camera();
    if (!mode.ortho) return { ...cam, fov: S.fov };
    // 직교 뷰: 눈은 같은 방향으로 멀리 두어 앞쪽 물체가 잘리지 않게 한다
    const back = normalize(sub(cam.eye, cam.target));
    return { eye: add(cam.target, scale(back, 60)), target: cam.target, up: cam.up,
             orthographic: true, halfHeight: S.distance * tanHalf(), near: .1, far: 200 };
  }

  // 전체 지도: 기본 전체 보기와 같은 방향의 고정 카메라
  function overviewCamera() {
    const v = homeView(), d = 27;
    // yaw·pitch 로 (0,0,d) 를 돌린 위치 = 눈. Ry(yaw)·Rx(pitch)·(0,0,d)
    const off = [d * Math.cos(v.pitch) * Math.sin(v.yaw), -d * Math.sin(v.pitch), d * Math.cos(v.pitch) * Math.cos(v.yaw)];
    return { eye: add(v.target, off), target: v.target, up: [0, 1, 0], fov: 45 };
  }

  function insetViewport() {
    const W = canvas.width, H = canvas.height, m = Math.round(Math.min(W, H) * .02);
    let w = Math.round(W * .3), h = Math.round(w * .62);
    if (h > H * .38) { h = Math.round(H * .38); w = Math.round(h / .62); }
    return [W - w - m, m, w, h];                     // 원점은 왼쪽 아래 (drawView 규칙)
  }

  // 3차원 점 → 그리기 버퍼 좌표 (overlay 는 위쪽이 원점)
  function project(cam, vp, p) {
    const [vx, vy, vw, vh] = vp, aspect = vw / vh;
    const f = normalize(sub(cam.target, cam.eye)), r = normalize(cross(f, cam.up)), u = cross(r, f);
    const rel = sub(p, cam.eye);
    let nx, ny;
    if (cam.orthographic) {
      nx = dot(rel, r) / (cam.halfHeight * aspect); ny = dot(rel, u) / cam.halfHeight;
    } else {
      const z = dot(rel, f); if (z <= .05) return null;
      const t = Math.tan((cam.fov || 45) * Math.PI / 360);
      nx = dot(rel, r) / (z * t * aspect); ny = dot(rel, u) / (z * t);
    }
    return [vx + (nx + 1) / 2 * vw, overlay.height - (vy + (ny + 1) / 2 * vh)];
  }

  const COLORS = { A: '#1f6fd1', B: '#e0701c', mark: '#e5213b', done: '#2e9e5b' };

  function drawOverlay(main, inset, ivp) {
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
      overlay.width = canvas.width; overlay.height = canvas.height;
    }
    const W = overlay.width, H = overlay.height, px = Math.max(1, W / canvas.clientWidth);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${Math.round(12 * px)}px sans-serif`;
    const fullVp = [0, 0, W, H];
    const item = tasks[mode.index];

    // ① 본 화면: 지금 보는 표지를 모서리 괄호로 표시 (어느 장치의 정보인지)
    if (item && !item.members && !anim) {
      const half = [item.size[0] / 2 * 1.25, item.size[1] / 2 * 1.35];
      const rt = [Math.cos(item.yaw), 0, -Math.sin(item.yaw)];
      const pts = [[-1,-1],[1,-1],[1,1],[-1,1]].map(([a, b]) =>
        project(main, fullVp, add(item.position, add(scale(rt, a * half[0]), [0, b * half[1], 0]))));
      if (pts.every(Boolean)) {
        ctx.strokeStyle = COLORS.mark; ctx.lineWidth = 3 * px;
        for (let i = 0; i < 4; i++) {
          const [x, y] = pts[i], [nx, ny] = pts[(i + 1) % 4], [px2, py2] = pts[(i + 3) % 4];
          const k = .22;
          ctx.beginPath();
          ctx.moveTo(x + (nx - x) * k, y + (ny - y) * k); ctx.lineTo(x, y); ctx.lineTo(x + (px2 - x) * k, y + (py2 - y) * k);
          ctx.stroke();
        }
        const top = Math.min(...pts.map(p => p[1]));
        const label = `${item.id} ${item.name}`;
        const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
        const tw = ctx.measureText(label).width + 12 * px;
        ctx.fillStyle = 'rgba(18,35,55,.85)';
        ctx.fillRect(cx - tw / 2, top - 26 * px, tw, 20 * px);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, top - 16 * px);
      }
    }

    // ② 직교 뷰: 비교할 모서리의 기준선 (답을 적지 않고 선만 긋는다)
    if (item && item.members && mode.ortho) {
      const boxes = memberBoxes(item), names = ['A', 'B'];
      ctx.lineWidth = 2.5 * px; ctx.setLineDash([8 * px, 6 * px]);
      boxes.forEach((b, k) => {
        const c = COLORS[names[k]]; ctx.strokeStyle = c; ctx.fillStyle = c;
        const lo = sub(b.position, scale(b.size, .5)), hi = add(b.position, scale(b.size, .5));
        const line = (p, q) => {                       // 흰 바탕선 위에 색 점선 — 같은 색 물체 위에서도 보이게
          const a = project(main, fullVp, p), z = project(main, fullVp, q);
          ctx.save(); ctx.setLineDash([]); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 4 * px;
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...z); ctx.stroke(); ctx.restore();
          ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...z); ctx.stroke(); };
        ctx.lineDashOffset = k * 7 * px;             // 두 선이 겹쳐도 둘 다 보이게 엇갈린 점선
        if (item.id === 'O1') {
          line([-60, hi[1], hi[2]], [60, hi[1], hi[2]]);                 // 상단 높이
          line([lo[0], -60, hi[2]], [lo[0], 60, hi[2]]);                 // 왼쪽 끝
          line([hi[0], -60, hi[2]], [hi[0], 60, hi[2]]);                 // 오른쪽 끝
          const t = project(main, fullVp, [lo[0], hi[1], hi[2]]);
          ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`${names[k]} 상단`, t[0] + 4 * px, t[1] - (k ? 14 : 2) * px);
        } else {
          line([hi[0], -60, hi[2]], [hi[0], 60, hi[2]]);                 // +z 쪽 전면 끝
          const t = project(main, fullVp, [hi[0], hi[1], hi[2]]);
          ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(`${names[k]} 전면 끝`, t[0] - 4 * px, t[1] - 4 * px);
        }
      });
      ctx.setLineDash([]);
      // 화면 축 안내
      const axis = item.id === 'O1'
        ? '전면 직교 뷰 · +z 쪽에서 −z 방향을 봄 · 가로 = x, 세로 = y · 두 대상 같은 배율'
        : '오른쪽 측면 직교 뷰 · +x 쪽에서 −x 방향을 봄 · 가로 = z(왼쪽이 건물 앞 +z), 세로 = y · 같은 배율';
      ctx.fillStyle = 'rgba(18,35,55,.85)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(axis).width + 16 * px;
      ctx.fillRect(10 * px, 10 * px, tw, 24 * px);
      ctx.fillStyle = '#fff'; ctx.fillText(axis, 18 * px, 22 * px);
    }

    // ③ 전체 지도: 테두리, 모든 지점, 현재 위치
    const [ix, iy, iw, ih] = ivp, top = H - iy - ih;
    ctx.strokeStyle = 'rgba(18,35,55,.9)'; ctx.lineWidth = 2 * px; ctx.strokeRect(ix, top, iw, ih);
    ctx.fillStyle = 'rgba(18,35,55,.85)'; ctx.fillRect(ix, top, 64 * px, 18 * px);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('전체 지도', ix + 6 * px, top + 9 * px);
    ctx.save(); ctx.beginPath(); ctx.rect(ix, top, iw, ih); ctx.clip();
    ctx.font = `bold ${Math.round(10 * px)}px sans-serif`;
    tasks.forEach((t, i) => {
      const p = project(inset, ivp, t.position); if (!p) return;
      const current = i === mode.index;
      ctx.beginPath(); ctx.arc(p[0], p[1], (current ? 7 : 4) * px, 0, Math.PI * 2);
      ctx.fillStyle = current ? COLORS.mark : done.has(t.id) ? COLORS.done : 'rgba(18,35,55,.75)';
      ctx.fill();
      ctx.fillStyle = current ? COLORS.mark : '#122337'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillText(t.id, p[0] + 5 * px, p[1] - 3 * px);
    });
    // 본 화면의 카메라 위치(눈)를 작은 삼각형으로
    const eye = project(inset, ivp, controls.camera().eye), tgt = project(inset, ivp, S.target);
    if (eye && tgt && !mode.ortho) {
      ctx.strokeStyle = COLORS.mark; ctx.lineWidth = 1.5 * px; ctx.setLineDash([3 * px, 3 * px]);
      ctx.beginPath(); ctx.moveTo(...eye); ctx.lineTo(...tgt); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = COLORS.mark; ctx.beginPath(); ctx.arc(eye[0], eye[1], 3 * px, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  viewer.render = api => {
    step(performance.now());
    const main = mainCamera();
    api.drawView(main);
    const ivp = insetViewport(), inset = overviewCamera();
    api.drawView(inset, ivp);
    drawOverlay(main, inset, ivp);
  };

  /* ───────────────────────── D. 패널 UI ───────────────────────── */

  const done = new Set();
  const ui = document.querySelector('#student-ui');
  const list = document.querySelector('#tasks');
  list.parentElement.insertBefore(ui, list);         // 안내 막대를 목록 위로
  ui.innerHTML = `
    <div class="guide-box">
      <div class="guide-now" id="g-now">전체 보기</div>
      <div class="guide-progress" id="g-progress"></div>
      <div class="actions">
        <button class="btn" id="g-prev" type="button">◀ 이전</button>
        <button class="btn" id="g-next" type="button">다음 ▶</button>
      </div>
      <div class="actions">
        <button class="btn" id="g-home" type="button">전체 보기로 복귀</button>
        <button class="btn" id="g-done" type="button" disabled>확인 완료 ✓</button>
      </div>
      <p class="guide-hint" id="g-hint">목록의 지점을 누르면 그 표지를 읽기 좋은 위치로 이동합니다.</p>
    </div>`;
  const style = document.createElement('style');
  style.textContent = `
    .guide-box{margin:10px 0;padding:10px;border:1px solid var(--d-line,#ccd);border-radius:8px}
    .guide-now{font-weight:700;font-size:15px}.guide-progress{font-size:12px;margin:4px 0 8px;color:var(--d-muted,#566)}
    .guide-box .actions{margin-top:6px}.guide-hint{font-size:12px;margin:8px 0 0;color:var(--d-muted,#566)}
    #tasks li{cursor:pointer;padding:4px 6px;border-radius:6px;border:1px solid transparent}
    #tasks li:hover{background:rgba(31,111,209,.08)}
    #tasks li.is-current{border-color:#e5213b;background:rgba(229,33,59,.07)}
    #tasks li.is-done strong::after{content:'  ✓ 확인';color:#2e9e5b;font-size:12px}`;
  document.head.appendChild(style);

  const items = [...list.querySelectorAll('li')];
  items.forEach((li, i) => {
    li.tabIndex = 0; li.setAttribute('role', 'button');
    li.addEventListener('click', () => flyTo(viewFor(i), i));
    li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flyTo(viewFor(i), i); } });
  });

  function goHome(animate = true) {
    if (animate) flyTo(homeView(), -1);
    else { anim = null; mode.index = -1; mode.ortho = false; S.lockRotation = false; updatePanel(); }
  }
  const $ = id => document.getElementById(id);
  $('g-prev').addEventListener('click', () => { const i = mode.index <= 0 ? tasks.length - 1 : mode.index - 1; flyTo(viewFor(i), i); });
  $('g-next').addEventListener('click', () => { const i = (mode.index + 1) % tasks.length; flyTo(viewFor(i), i); });
  $('g-home').addEventListener('click', () => goHome(true));
  $('home').addEventListener('click', () => goHome(false));   // 기존 버튼은 즉시 복귀
  $('g-done').addEventListener('click', () => {
    const t = tasks[mode.index]; if (!t) return;
    done.has(t.id) ? done.delete(t.id) : done.add(t.id);
    S.actions++; updatePanel();
  });
  document.querySelector('#measure').addEventListener('click', () => { done.clear(); updatePanel(); });

  function updatePanel() {
    const t = tasks[mode.index];
    $('g-now').textContent = t ? `지금 보는 곳: ${t.id} ${t.name} (${mode.index + 1}/${tasks.length})` : '지금 보는 곳: 전체 보기';
    const left = tasks.filter(x => !done.has(x.id)).map(x => x.id);
    $('g-progress').textContent = `확인 완료 ${done.size} / ${tasks.length}` + (left.length ? ` · 남은 곳: ${left.join(', ')}` : ' · 모두 확인했습니다');
    $('g-done').disabled = !t;
    $('g-done').textContent = t && done.has(t.id) ? '확인 취소' : '확인 완료 ✓';
    $('g-hint').textContent = !t ? '목록의 지점을 누르면 그 표지를 읽기 좋은 위치로 이동합니다.'
      : t.members ? '직교 뷰입니다. 축 정렬을 지키려고 회전을 잠갔습니다. 드래그 = 이동, 휠 = 확대. 점선은 비교할 모서리입니다.'
      : '회전 중심이 이 표지로 바뀌었습니다. 드래그하면 표지 주위를 돌아 주변 장치를 볼 수 있습니다.';
    items.forEach((li, i) => {
      li.classList.toggle('is-current', i === mode.index);
      li.classList.toggle('is-done', done.has(tasks[i].id));
    });
  }
  updatePanel();
})();
