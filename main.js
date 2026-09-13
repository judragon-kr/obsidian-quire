'use strict';

/*
 * Quire — 필기 전용 무한 화이트보드
 *
 * Pencil(38KB) 이 느렸던 이유가 셋이었다. 여기서는 그 셋을 다르게 한다.
 *
 *   1  매 프레임 캔버스를 통째로 지우고 다시 그렸다  → 획이 쌓일수록 선형으로 느려진다
 *      여기서는 캔버스를 두 장 쓴다. 끝난 획은 base 에 한 번만 굽고,
 *      그리는 중인 획만 live 에 그린다. base 는 화면이 움직일 때만 다시 굽는다.
 *
 *   2  getCoalescedEvents 를 안 썼다  → Apple Pencil 은 240Hz 로 찍는데
 *      pointermove 는 60Hz 로 온다. 안 쓰면 점 넷 중 셋을 버린다.
 *
 *   3  getPredictedEvents 를 안 썼다  → 펜 끝이 획보다 앞서 보인다.
 *      예측점을 live 에만 그리면 체감 지연이 줄고, 확정되면 지워진다.
 *
 * 저장은 TextFileView 라 옵시디언이 더티 추적·저장을 알아서 한다.
 * 좌표는 화면이 아니라 **월드 좌표**로 둔다 — 확대·이동해도 획이 안 흔들린다.
 */

const { TextFileView, Plugin, Notice, Modal, requestUrl } = require('obsidian');

const VIEW_TYPE = 'quire';
const EXT = 'quire';

const WIDTHS = [1.2, 2.2, 4, 7];
const GRID_BASE = 28;   // world 단위 기본 간격. 화면 간격은 줌에 따라 2배씩 오르내린다

// Obsidian 테마 변수를 실제 색으로 푼다. 캔버스는 var() 를 못 받는다.
function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const GRIDS = ['off', 'dot', 'line'];
const PALETTE = ['#2f6de0', '#e03131', '#2f9e44', '#f08c00', '#343a40', '#ffffff'];

// v2 에서 images 가 붙었다. v1 파일은 images 가 없을 뿐 그대로 열린다 —
// setViewData 가 없으면 빈 배열을 넣는다. 버전을 올렸다고 옛 파일을 거르지 않는다.
const DEFAULT = () => ({ v: 2, strokes: [], images: [], view: { x: 0, y: 0, k: 1 } });

// 꾹 누르기 — 점 찍기와 가르는 축은 **거리가 아니라 시간**이다.
//   420ms · 9px   손떨림에 취소 — 거의 안 떴음
//   280ms · 22px  점 찍는 굴림에 발동 — 오발동
// 둘 다 시간이 짧아 점과 겹쳤다. 점은 눌렀다 바로 뗀다(보통 300ms 아래).
// 시간을 늘리고 거리는 다시 조인다. 움직이면 취소되고, 링으로 진행이 보인다.
const LONG_MS = 620;
const LONG_SLOP = 14;   // 화면 px. 이보다 움직이면 획을 그으려는 것으로 본다

// 펜을 댄 채 손가락으로 톡 — 기다림 없이 메뉴를 연다.
// 손가락을 **뗄 때** 열어서 화면에 얹어 둔 손바닥은 절대 안 걸린다(계속 닿아 있으므로).
const TAP_MS = 320;     // 이 안에 떼야 톡으로 침
const TAP_SLOP = 16;    // 이보다 움직이면 톡이 아니다

// 다각형 안에 있나 — 광선 투사. 올가미가 이걸로 획을 고른다.
function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

// ── 획 하나 ────────────────────────────────────────────────
// pts 는 [x, y, pressure, x, y, pressure, …] 로 납작하게 둔다.
// 객체 배열로 두면 획 수천 개에서 GC 가 눈에 띈다.
function bboxOf(pts, w) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const pad = w * 2 + 4;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

// 중점을 지나는 2차 곡선. lineTo 만 쓰면 각이 진다.
function drawStroke(ctx, s, k) {
  const p = s.pts, n = p.length / 3;
  if (n === 0) return;
  ctx.strokeStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = s.a != null ? s.a : 1;

  // 화면에서 0.35px 밑으로는 안 내려간다. k 로 나누는 것은 world 단위라서다.
  const wAt = (i) => Math.max(0.35 / k, s.w * (0.35 + 0.65 * p[i * 3 + 2]));

  if (n === 1) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], wAt(0) * 0.5, 0, 6.284);
    ctx.fillStyle = s.c;
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  if (n === 2) {
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[3], p[4]);
    ctx.lineWidth = wAt(1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  // 중점 이차곡선 — 점 i 를 제어점으로 두고 앞뒤 중점을 잇는다.
  // 제어점을 시작점과 같게 주면 곡선이 아니라 직선이 된다.
  // 구간마다 굵기가 달라지므로 한 구간이 한 path 다.
  let mx = (p[0] + p[3]) / 2, my = (p[1] + p[4]) / 2;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo(mx, my);
  ctx.lineWidth = wAt(1);
  ctx.stroke();

  for (let i = 1; i < n - 1; i++) {
    const cx = p[i * 3], cy = p[i * 3 + 1];
    const nx = (cx + p[(i + 1) * 3]) / 2, ny = (cy + p[(i + 1) * 3 + 1]) / 2;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(cx, cy, nx, ny);
    ctx.lineWidth = wAt(i);
    ctx.stroke();
    mx = nx; my = ny;
  }

  ctx.beginPath();
  ctx.moveTo(mx, my);
  ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]);
  ctx.lineWidth = wAt(n - 1);
  ctx.stroke();
  ctx.globalAlpha = 1;
}


// 이미지 한 장. el 이 아직 안 실렸으면 자리만 표시한다 —
// 빈 곳으로 두면 「안 들어갔다」로 보이고, 실린 뒤 다시 굽는다.
function drawImage(ctx, im, el) {
  if (el && el.complete && el.naturalWidth) {
    ctx.drawImage(el, im.x, im.y, im.w, im.h);
  } else {
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#8888';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(im.x, im.y, im.w, im.h);
    ctx.restore();
  }
  // 출처. Openverse 에서 가져온 것은 라이선스가 따라와야 한다.
  if (im.attr) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = '#888';
    const fs = Math.max(6, Math.min(14, im.w / 26));
    ctx.font = `${fs}px sans-serif`;
    ctx.fillText(im.attr, im.x, im.y + im.h + fs * 1.25, im.w);
    ctx.restore();
  }
}

function imgBB(im) { return [im.x, im.y, im.x + im.w, im.y + im.h]; }

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx, qy = ay + t * dy;
  return Math.hypot(px - qx, py - qy);
}

class QuireView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.doc = DEFAULT();
    const st = plugin.settings;
    this.tool = st.tool;
    this.color = st.color;
    this.width = st.width;
    this.pressure = st.pressure;
    this.grid = st.grid;
    this.map = st.map;
    this.palOn = st.palOn;
    this._bb = null;        // 내용 사각형 캐시. 획이 바뀌면 버린다
    this._pats = new Map();  // 격자 타일. 모드×간격×색×dpr 로 키를 잡는다
    this.undoStack = [];
    this.redoStack = [];
    this.cur = null;          // 그리는 중인 획
    this.needBake = true;     // base 를 다시 구워야 하나
    this.raf = 0;
    this.touches = new Map();   // 손가락만. 펜은 절대 여기 안 들어간다
    this.pinch = null;
    this.sel = { s: new Set(), i: new Set() };  // 고른 획·이미지 인덱스
    this.lasso = null;        // 올가미를 그리는 중이면 [x,y,…]
    this.drag = null;         // 고른 것을 끄는 중이면 {ox,oy,dx,dy}
    this._img = new Map();    // src → HTMLImageElement. 비동기로 실린다
    this.radial = null;       // 방사형 메뉴가 떠 있으면 {cx,cy,hit}
  }

  get hasSel() { return this.sel.s.size > 0 || this.sel.i.size > 0; }

  clearSel() {
    if (!this.hasSel && !this.lasso) return;
    this.sel.s.clear(); this.sel.i.clear();
    this.lasso = null;
    this.drag = null;
    this.needBake = true;
    this.schedule();
  }

  getViewType() { return VIEW_TYPE; }
  getIcon() { return 'pencil'; }
  getDisplayText() { return this.file ? this.file.basename : 'Quire'; }

  // ── 파일 ↔ 메모리 ────────────────────────────────────────
  getViewData() { return JSON.stringify(this.doc); }

  setViewData(data, clear) {
    // 파일마다 새로 판정한다. 안 지우면 깨진 파일 하나 연 뒤로
    // 같은 탭에서 여는 모든 파일이 조용히 저장을 안 한다.
    this.readonly = false;
    // 이력은 파일 경계에서 끊는다. 안 끊으면 undo 가 앞 파일의 획을
    // 지금 파일에 밀어 넣는다.
    this.resetHistory();
    try {
      const d = data && data.trim() ? JSON.parse(data) : DEFAULT();
      this.doc = d && Array.isArray(d.strokes) ? d : DEFAULT();
    } catch (e) {
      // 깨진 파일을 빈 것으로 덮으면 내용이 날아간다. 열지 않고 알린다.
      new Notice('Quire — could not read this file. It will not be overwritten.');
      this.doc = DEFAULT();
      this.readonly = true;
    }
    this._bb = null;
    if (!this.doc.view) this.doc.view = { x: 0, y: 0, k: 1 };
    // v1 파일에는 images 가 없다. 없다고 거르지 않고 빈 배열을 준다.
    if (!Array.isArray(this.doc.images)) this.doc.images = [];
    this.sel.s.clear(); this.sel.i.clear();
    this.lasso = null; this.drag = null; this.radial = null;
    this.needBake = true;
    this.resize();
  }

  clear() { this.doc = DEFAULT(); this._bb = null; this.needBake = true;
           this.sel.s.clear(); this.sel.i.clear(); this.resetHistory(); }

  resetHistory() {
    this.undoStack = [];
    this.redoStack = [];
    if (this.penBtn) this.refreshBar();
  }

  // ── 화면 ────────────────────────────────────────────────
  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('quire-root');

    this.wrap = root.createDiv({ cls: 'quire-wrap' });
    this.base = this.wrap.createEl('canvas', { cls: 'quire-c' });
    this.live = this.wrap.createEl('canvas', { cls: 'quire-c' });

    // desynchronized — 저지연 경로. 이게 체감 지연을 크게 줄인다.
    this.bctx = this.base.getContext('2d', { desynchronized: true });
    this.lctx = this.live.getContext('2d', { desynchronized: true, alpha: true });

    this.buildToolbar(root);
    this.buildPalette();

    // touch-action: none 이 없으면 그리는 중에 화면이 스크롤된다.
    this.live.style.touchAction = 'none';

    // ── iPadOS 는 TouchEvent 로 받는다 ────────────────────────
    // 손이 닿아 있는 동안 WebKit 이 **둘째 펜 접촉의 pointerdown 을 안 준다.**
    // 실측으로 확인했다 — f 를 쓰고 펜을 뗀 뒤 다시 대면 p·down 이 안 찍힌다.
    // TouchEvent 에는 그 제약이 없고, Touch.touchType 으로 펜을 가려낼 수 있다.
    this.tStart = (e) => this.onTouch(e, 'start');
    this.tMove = (e) => this.onTouch(e, 'move');
    this.tEnd = (e) => this.onTouch(e, 'end');
    this.live.addEventListener('touchstart', this.tStart, { passive: false });
    this.live.addEventListener('touchmove', this.tMove, { passive: false });
    this.live.addEventListener('touchend', this.tEnd, { passive: false });
    this.live.addEventListener('touchcancel', this.tEnd, { passive: false });

    this.winDown = (e) => { if (this.inCanvas(e)) this.onDown(e); };
    window.addEventListener('pointerdown', this.winDown, { passive: false });
    // move/up 은 **window** 에 건다. 손이 닿아 있으면 iPadOS 가 캡처를 뺏어 가서
    // 캔버스에만 걸면 획 중간에 이벤트가 끊긴다.
    this.winMove = (e) => this.onMove(e);
    this.winUp = (e) => this.onUp(e);
    this.winCancel = (e) => this.onCancel(e);
    window.addEventListener('pointermove', this.winMove, { passive: false });
    window.addEventListener('pointerup', this.winUp);
    window.addEventListener('pointercancel', this.winCancel);
    this.live.addEventListener('wheel', this.onWheel, { passive: false });

    // 붙여넣기 · 끌어다 놓기로도 이미지가 들어온다
    this.onPaste = (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (!f) continue;
          e.preventDefault();
          f.arrayBuffer().then((b) => this.addFromBlob(f.name || `pasted.${it.type.split('/')[1]}`, b));
          return;
        }
      }
    };
    this.onDrop = (e) => {
      const fs = e.dataTransfer && e.dataTransfer.files;
      if (!fs || !fs.length) return;
      e.preventDefault();
      for (const f of fs) {
        if (f.type && f.type.startsWith('image/')) f.arrayBuffer().then((b) => this.addFromBlob(f.name, b));
      }
    };
    this.onDragOver = (e) => { if (e.dataTransfer) e.preventDefault(); };
    // Delete 로 고른 것을 지운다. Escape 로 선택·메뉴를 접는다.
    this.onKey = (e) => {
      if (!this.hasSel && !this.radial) return;
      if (e.key === 'Escape') { this.closeRadial(false); this.clearSel(); e.preventDefault(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.hasSel) {
        this.deleteSel(); e.preventDefault();
      }
    };
    root.addEventListener('paste', this.onPaste);
    this.wrap.addEventListener('drop', this.onDrop);
    this.wrap.addEventListener('dragover', this.onDragOver);
    window.addEventListener('keydown', this.onKey);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.wrap);
    this.resize();
  }

  async onClose() {
    if (this.ro) this.ro.disconnect();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.live.removeEventListener('touchstart', this.tStart);
    this.live.removeEventListener('touchmove', this.tMove);
    this.live.removeEventListener('touchend', this.tEnd);
    this.live.removeEventListener('touchcancel', this.tEnd);
    window.removeEventListener('pointerdown', this.winDown);
    window.removeEventListener('pointermove', this.winMove);
    window.removeEventListener('pointerup', this.winUp);
    window.removeEventListener('pointercancel', this.winCancel);
    window.removeEventListener('keydown', this.onKey);
    if (this.contentEl) this.contentEl.removeEventListener('paste', this.onPaste);
    if (this.wrap) {
      this.wrap.removeEventListener('drop', this.onDrop);
      this.wrap.removeEventListener('dragover', this.onDragOver);
    }
  }

  buildToolbar(root) {
    const bar = root.createDiv({ cls: 'quire-bar' });
    const btn = (label, title, fn, key) => {
      const b = bar.createEl('button', { text: label, attr: { 'aria-label': title, title } });
      b.onclick = fn;
      if (key) b.dataset.tool = key;
      return b;
    };
    this.penBtn = btn('✏️', 'Pen', () => this.setTool('pen'), 'pen');
    this.hlBtn = btn('🖍', 'Highlighter', () => this.setTool('hl'), 'hl');
    this.erBtn = btn('🩹', 'Eraser (whole stroke)', () => this.setTool('er'), 'er');
    this.selBtn = btn('⬚', 'Select — lasso, then drag to move', () => this.setTool('sel'), 'sel');

    bar.createSpan({ cls: 'quire-sep' });
    btn('🖼', 'Insert image from this vault or your device', () => this.pickImage());
    btn('🔍', 'Search Openverse for an image', () => new ImageSearch(this.app, this).open());

    bar.createSpan({ cls: 'quire-sep' });
    this.undoBtn = btn('↩︎', 'Undo', () => this.undo());
    this.redoBtn = btn('↪︎', 'Redo', () => this.redo());

    // ── 굵기 ── 점 크기가 실제 굵기에 비례한다. 숫자보다 이게 빠르다.
    bar.createSpan({ cls: 'quire-sep' });
    this.wEls = [];
    for (const w of WIDTHS) {
      const d = bar.createDiv({ cls: 'quire-w', attr: { 'aria-label': `Width ${w}`, title: `Width ${w}` } });
      d.dataset.w = String(w);
      const dot = d.createDiv({ cls: 'quire-wdot' });
      const px = Math.min(18, 3 + w * 1.9);
      dot.style.width = dot.style.height = `${px}px`;
      d.onclick = () => this.setWidth(w);
      this.wEls.push(d);
    }

    // ── 색 ── 고른 것에 테두리가 생긴다
    bar.createSpan({ cls: 'quire-sep' });
    this.swEls = [];
    for (const c of PALETTE) {
      const d = bar.createDiv({ cls: 'quire-sw', attr: { 'aria-label': c, title: c } });
      d.dataset.color = c;
      d.style.background = c;
      d.onclick = () => this.setColor(c);
      this.swEls.push(d);
    }
    // 임의 색. label 로 감싸야 iPadOS 에서 색 선택기가 뜬다.
    this.customSw = bar.createEl('label', { cls: 'quire-sw quire-sw-custom', attr: { 'aria-label': 'Custom colour', title: 'Custom colour' } });
    const ci = this.customInput = this.customSw.createEl('input', { type: 'color' });
    ci.value = this.color;
    ci.oninput = () => this.setColor(ci.value);

    // ── 필압 ──
    bar.createSpan({ cls: 'quire-sep' });
    this.prBtn = btn('◐', 'Pressure sensitivity', () => this.setPressure(!this.pressure));

    bar.createSpan({ cls: 'quire-sep' });
    this.gridBtn = btn('▦', 'Grid: off / dots / lines', () =>
      this.setGrid(GRIDS[(GRIDS.indexOf(this.grid) + 1) % GRIDS.length]));
    this.mapBtn = btn('🗺', 'Minimap', () => this.setMap(!this.map));
    this.palBtn = btn('🎛', 'Floating palette — drag it where your hand rests',
                      () => this.setPalette(!this.palOn));
    btn('⊙', 'Fit to content', () => this.fit());
    btn('🐞', 'Toggle input diagnostics', () => {
      this.dbg = !this.dbg;
      this.dbgEl.style.display = this.dbg ? 'block' : 'none';
      this.paintDbg();
    });
    this.dbgEl = this.wrap.createDiv({ cls: 'quire-dbg' });
    this.dbgEl.style.display = 'none';
    this.counts = { pen: {}, touch: {}, mouse: {} };
    this.refreshBar();
  }

  // 필압을 굵기에 얼마나 반영할지. 끄면 1(고정 굵기), 형광펜은 항상 고정.
  // 마우스는 pressure 를 0 으로 주므로 0.5 로 받는다.
  inCanvas(e) {
    const r = this.live.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right &&
           e.clientY >= r.top && e.clientY <= r.bottom;
  }

  prOf(raw) {
    if (!this.pressure || this.tool === 'hl') return 1;
    return raw > 0 ? Math.min(1, raw) : 0.5;
  }

  newStroke(x, y, pr) {
    const hl = this.tool === 'hl';
    return {
      c: this.color,
      w: hl ? this.width * 6 : this.width,
      a: hl ? 0.35 : 1,
      pts: [x, y, pr],
    };
  }

  get eraserR() { return Math.max(8, this.width * 5); }

  // 그리는 중이던 획을 문서에 넣고 base 에 한 번만 굽는다. 전체 재굽기가 아니다.
  commitStroke() {
    if (!this.cur || this.cur.pts.length < 3) { this.cur = null; return; }
    this.snapshot();
    this.cur.bb = bboxOf(this.cur.pts, this.cur.w);
    this.doc.strokes.push(this.cur);
    this._bb = null;
    this.applyXform(this.bctx);
    drawStroke(this.bctx, this.cur, this.doc.view.k);
    this.cur = null;
    this.commitDoc();
  }

  // 획 배열은 확정 뒤 안 바뀌므로 얕은 복사면 된다.
  // 이동은 획 안의 pts 를 고치므로 그때만 깊은 복사를 쓴다(아래 dropDrag).
  snapshot() {
    this.undoStack.push({ s: this.doc.strokes.slice(), i: this.doc.images.slice() });
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
    this.refreshBar();
  }

  // 되돌리기가 선택을 살려 두면 없어진 획을 가리키게 된다. 항상 비운다.
  _restore(from, to) {
    if (!from.length) return;
    to.push({ s: this.doc.strokes.slice(), i: this.doc.images.slice() });
    const st = from.pop();
    this.doc.strokes = st.s;
    this.doc.images = st.i;
    this.sel.s.clear(); this.sel.i.clear();
    this.drag = null; this.lasso = null;
    this._bb = null;
    this.needBake = true;
    this.schedule();
    this.commitDoc();
    this.refreshBar();
  }

  undo() { this._restore(this.undoStack, this.redoStack); }
  redo() { this._restore(this.redoStack, this.undoStack); }

  setTool(t) {
    this.tool = t;
    this.plugin.settings.tool = t;
    this.plugin.queueSave();
    this.refreshBar();
  }

  setColor(c) {
    this.color = c;
    if (this.tool === 'er') { this.tool = 'pen'; this.plugin.settings.tool = 'pen'; }
    this.plugin.settings.color = c;
    this.plugin.queueSave();
    this.refreshBar();
  }

  setWidth(w) {
    this.width = w;
    this.plugin.settings.width = w;
    this.plugin.queueSave();
    this.refreshBar();
  }

  setGrid(g) {
    this.grid = g;
    this.plugin.settings.grid = g;
    this.plugin.queueSave();
    this.needBake = true;
    this.schedule();
    this.refreshBar();
  }

  setMap(on) {
    this.map = on;
    this.plugin.settings.map = on;
    this.plugin.queueSave();
    this.drawLive();
    this.refreshBar();
  }

  setPressure(on) {
    this.pressure = on;
    this.plugin.settings.pressure = on;
    this.plugin.queueSave();
    this.refreshBar();
  }

  // 툴바의 모든 선택 표시를 한 자리에서 다시 칠한다.
  // 색·굵기가 눌려도 아무 표시가 없던 것이 여기 없어서였다.
  refreshBar() {
    if (!this.penBtn) return;
    for (const b of [this.penBtn, this.hlBtn, this.erBtn, this.selBtn]) {
      b.toggleClass('is-on', b.dataset.tool === this.tool);
    }
    for (const d of this.swEls) {
      d.toggleClass('is-on', d.dataset.color === this.color && this.tool !== 'er');
    }
    for (const d of this.wEls) {
      d.toggleClass('is-on', Number(d.dataset.w) === this.width);
    }
    if (this.palBtn) this.palBtn.toggleClass('is-on', this.palOn);
    if (this.pal) {
      for (const k in this.palTool) this.palTool[k].toggleClass('is-on', k === this.tool);
      for (const d of this.palW) d.toggleClass('is-on', Number(d.dataset.w) === this.width);
      for (const d of this.palC) d.toggleClass('is-on', d.dataset.color === this.color && this.tool !== 'er');
    }
    this.prBtn.toggleClass('is-on', this.pressure);
    this.gridBtn.toggleClass('is-on', this.grid !== 'off');
    this.gridBtn.setText(this.grid === 'line' ? '▤' : '▦');
    this.mapBtn.toggleClass('is-on', this.map);
    this.undoBtn.toggleClass('is-off', this.undoStack.length === 0);
    this.redoBtn.toggleClass('is-off', this.redoStack.length === 0);
    this.customSw.style.background = this.color;
    this.customInput.value = this.color;
  }

  resize() {
    if (!this.wrap) return;
    const r = this.wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.live]) {
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      c.style.width = r.width + 'px';
      c.style.height = r.height + 'px';
    }
    this.dpr = dpr;
    if (this.pal) this.movePalette(parseFloat(this.pal.style.left) || 16, parseFloat(this.pal.style.top) || 96);
    this.needBake = true;
    this.schedule();
  }

  // ── 좌표 ────────────────────────────────────────────────
  toWorld(cx, cy) {
    const r = this.live.getBoundingClientRect();
    const v = this.doc.view;
    return [(cx - r.left - v.x) / v.k, (cy - r.top - v.y) / v.k];
  }

  applyXform(ctx) {
    const v = this.doc.view, d = this.dpr;
    ctx.setTransform(v.k * d, 0, 0, v.k * d, v.x * d, v.y * d);
  }

  // ── 그리기 ──────────────────────────────────────────────
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  render() {
    if (this.needBake) this.bake();
    this.drawLive();
  }

  // 끝난 획 전부. **화면이 움직였을 때만** 돈다.
  bake() {
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    this.drawGrid(ctx);
    this.applyXform(ctx);

    const v = this.doc.view;
    const r = this.wrap.getBoundingClientRect();
    // 화면 밖 획은 건너뛴다 — 무한 캔버스에서 이게 없으면 다시 굽는 값이 계속 커진다.
    const vx0 = -v.x / v.k, vy0 = -v.y / v.k;
    const vx1 = (r.width - v.x) / v.k, vy1 = (r.height - v.y) / v.k;

    let drawn = 0;
    // 이미지가 먼저. 획이 그 위에 얹힌다 — 그림에 주석을 다는 쓰임이라 이 순서다.
    for (let i = 0; i < this.doc.images.length; i++) {
      if (this.drag && this.sel.i.has(i)) continue;   // 끄는 중이면 live 가 맡는다
      const im = this.doc.images[i], b = imgBB(im);
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      drawImage(ctx, im, this.imgFor(im));
      drawn++;
    }
    for (let i = 0; i < this.doc.strokes.length; i++) {
      if (this.drag && this.sel.s.has(i)) continue;
      const s = this.doc.strokes[i], b = s.bb;
      if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
      drawStroke(ctx, s, v.k);
      drawn++;
    }
    this.lastDrawn = drawn;
    this.needBake = false;
  }

  // 그리는 중인 획만. 매 프레임 돌아도 싸다.
  // 격자는 base 에 굽는다 — 화면이 움직일 때만 다시 그려지므로 획을 긋는 동안은 공짜다.
  // 간격은 화면 기준 16~64px 에 들어오게 2의 거듭제곱으로 올린다.
  // 안 그러면 축소했을 때 선이 뭉개져 회색 판이 된다.
  drawGrid(ctx) {
    if (this.grid === 'off') return;
    const v = this.doc.view, d = this.dpr;
    const r = this.wrap.getBoundingClientRect();

    // 화면 간격을 16~64px 안에 두고 2의 거듭제곱으로 오르내린다.
    // 안 그러면 축소했을 때 선이 뭉개져 회색 판이 된다.
    let step = GRID_BASE;
    while (step * v.k < 16) step *= 2;
    while (step * v.k > 64) step /= 2;
    // 타일이 이음매 없이 반복되려면 간격이 정수 CSS px 여야 한다
    const sp = Math.max(8, Math.round(step * v.k));

    const col = cssVar(this.wrap, '--background-modifier-border', '#8888');
    const pat = this.gridPattern(ctx, sp, col, d);
    if (!pat) return;

    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    // world 0 은 화면 v.x 에 있고 격자점은 v.x + n·sp 이므로 원점이 격자에 얹힌다
    const px = ((v.x % sp) + sp) % sp, py = ((v.y % sp) + sp) % sp;
    ctx.translate(px, py);
    ctx.fillStyle = pat;
    ctx.fillRect(-sp, -sp, r.width + sp * 2, r.height + sp * 2);
    ctx.setTransform(d, 0, 0, d, 0, 0);

    // 원점. 격자는 어디나 똑같이 생겨서 이것 없이는 절대 위치를 못 잡는다.
    const ox = v.x, oy = v.y;
    if (ox > -20 && ox < r.width + 20 && oy > -20 && oy < r.height + 20) {
      ctx.strokeStyle = cssVar(this.wrap, '--text-faint', '#888');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ox - 9, oy); ctx.lineTo(ox + 9, oy);
      ctx.moveTo(ox, oy - 9); ctx.lineTo(ox, oy + 9);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 격자 한 칸을 작은 캔버스에 한 번만 그려 두고 패턴으로 깐다.
  // 점을 하나하나 그리면 전체 화면에 1,000개가 넘어 핀치 줌 때마다 그만큼 든다.
  gridPattern(ctx, sp, col, d) {
    // 한 칸만 캐시하면 핀치 중에 sp 가 매 프레임 바뀌어 타일을 계속 새로 만든다.
    // sp 는 16~64 사이 정수뿐이라 칸을 여럿 둬도 몇십 개면 다 찬다.
    const key = `${this.grid}|${sp}|${col}|${d}`;
    const hit = this._pats.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = c.height = Math.max(1, Math.round(sp * d));
    const g = c.getContext('2d');
    if (!g) return null;
    g.scale(d, d);
    if (this.grid === 'line') {
      g.strokeStyle = col;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0.5, 0); g.lineTo(0.5, sp);
      g.moveTo(0, 0.5); g.lineTo(sp, 0.5);
      g.stroke();
    } else {
      g.fillStyle = col;
      g.beginPath();
      g.arc(0, 0, 1.1, 0, 6.284);
      g.fill();
    }
    const pat = ctx.createPattern(c, 'repeat');
    if (this._pats.size > 96) this._pats.clear();
    this._pats.set(key, pat);
    return pat;
  }


  // 획 전체를 감싸는 사각형. 미니맵이 매 프레임 쓰므로 캐시한다.
  contentBB() {
    if (this._bb) return this._bb;
    const ss = this.doc.strokes, ims = this.doc.images;
    if (!ss.length && !ims.length) return (this._bb = null);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const eat = (b) => {
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    };
    for (const s of ss) eat(s.bb || bboxOf(s.pts, s.w));
    for (const im of ims) eat(imgBB(im));
    return (this._bb = [x0, y0, x1, y1]);
  }

  // 선택 전체를 감싸는 사각형(world). 없으면 null.
  selBB() {
    if (!this.hasSel) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const eat = (b) => {
      if (b[0] < x0) x0 = b[0];
      if (b[1] < y0) y0 = b[1];
      if (b[2] > x1) x1 = b[2];
      if (b[3] > y1) y1 = b[3];
    };
    for (const i of this.sel.s) {
      const s = this.doc.strokes[i];
      if (s) eat(s.bb || bboxOf(s.pts, s.w));
    }
    for (const i of this.sel.i) {
      const im = this.doc.images[i];
      if (im) eat(imgBB(im));
    }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }

  // 미니맵은 live 에 화면 좌표로 얹는다. 내용 사각형과 지금 보는 창을 같이 그려
  // 「전체 중 어디를 보고 있나」를 한 눈에 준다.
  drawMap(ctx) {
    if (!this.map) return;
    const bb = this.contentBB();
    const r = this.wrap.getBoundingClientRect();
    const v = this.doc.view;
    // 지금 보고 있는 창(world)
    const wx0 = -v.x / v.k, wy0 = -v.y / v.k;
    const wx1 = (r.width - v.x) / v.k, wy1 = (r.height - v.y) / v.k;
    // 내용과 창을 함께 담는 범위. 내용이 없으면 창만.
    let x0 = wx0, y0 = wy0, x1 = wx1, y1 = wy1;
    if (bb) { x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]);
              x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]); }
    // 원점도 담아야 「원점에서 얼마나 왔나」가 보인다
    x0 = Math.min(x0, 0); y0 = Math.min(y0, 0);
    x1 = Math.max(x1, 0); y1 = Math.max(y1, 0);

    const MW = 108, MH = 78, PAD = 8, M = 6;
    const bx = r.width - MW - PAD, by = r.height - MH - PAD;
    const s = Math.min((MW - M * 2) / (x1 - x0 || 1), (MH - M * 2) / (y1 - y0 || 1));
    const ox = bx + MW / 2 - ((x0 + x1) / 2) * s;
    const oy = by + MH / 2 - ((y0 + y1) / 2) * s;
    const P = (wx, wy) => [ox + wx * s, oy + wy * s];

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 미니맵은 live 위에 있어 오른쪽 아래에 쓴 글씨를 가린다.
    // 긋는 동안은 흐리게 해서 밑이 비치게 한다.
    const A = this.cur ? 0.3 : 0.9;
    ctx.globalAlpha = A;
    ctx.fillStyle = cssVar(this.wrap, '--background-secondary', '#2226');
    ctx.strokeStyle = cssVar(this.wrap, '--background-modifier-border', '#8886');
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, MW, MH, 6);
    ctx.fill();
    ctx.stroke();

    if (bb) {
      const [ax, ay] = P(bb[0], bb[1]), [cx, cy] = P(bb[2], bb[3]);
      ctx.fillStyle = cssVar(this.wrap, '--text-faint', '#888');
      ctx.globalAlpha = A * 0.4;
      ctx.fillRect(ax, ay, Math.max(1, cx - ax), Math.max(1, cy - ay));
      ctx.globalAlpha = A;
    }
    // 원점
    const [zx, zy] = P(0, 0);
    ctx.fillStyle = cssVar(this.wrap, '--text-muted', '#999');
    ctx.fillRect(zx - 1.5, zy - 1.5, 3, 3);
    // 지금 보는 창
    const [vx, vy] = P(wx0, wy0), [vX, vY] = P(wx1, wy1);
    ctx.strokeStyle = cssVar(this.wrap, '--interactive-accent', '#4a8');
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, vy, Math.max(2, vX - vx), Math.max(2, vY - vy));
    ctx.restore();
  }

  drawLive() {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    const v = this.doc.view;

    if (this.cur) {
      this.applyXform(ctx);
      drawStroke(ctx, this.cur, v.k);
    }

    // 끄는 중인 선택 — base 에서 빠져 있으므로 여기서 옮겨 그린다
    if (this.drag) {
      ctx.save();
      this.applyXform(ctx);
      ctx.translate(this.drag.dx, this.drag.dy);
      for (const i of this.sel.i) {
        const im = this.doc.images[i];
        if (im) drawImage(ctx, im, this.imgFor(im));
      }
      for (const i of this.sel.s) {
        const s = this.doc.strokes[i];
        if (s) drawStroke(ctx, s, v.k);
      }
      ctx.restore();
    }

    this.drawSel(ctx);
    this.drawMap(ctx);
    this.drawHold(ctx);
    this.drawRadial(ctx);
  }

  // 올가미 자취와 선택 사각형. 화면 좌표로 그린다 — 점선 간격이 줌에 안 휘게.
  drawSel(ctx) {
    const v = this.doc.view, d = this.dpr;
    const S = (wx, wy) => [wx * v.k + v.x, wy * v.k + v.y];
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.strokeStyle = cssVar(this.wrap, '--interactive-accent', '#4a8');
    ctx.lineWidth = 1.5;

    if (this.lasso && this.lasso.length >= 4) {
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      for (let i = 0; i < this.lasso.length; i += 2) {
        const [sx, sy] = S(this.lasso[i], this.lasso[i + 1]);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      }
      ctx.closePath();
      ctx.stroke();
    }

    const bb = this.selBB();
    if (bb && !this.lasso) {
      const dx = this.drag ? this.drag.dx : 0, dy = this.drag ? this.drag.dy : 0;
      const [ax, ay] = S(bb[0] + dx, bb[1] + dy);
      const [cx, cy] = S(bb[2] + dx, bb[3] + dy);
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(ax - 3, ay - 3, cx - ax + 6, cy - ay + 6);
      ctx.setLineDash([]);
      // 몇 개를 골랐는지. 안 보이면 「골라졌나」를 모른다.
      const n = this.sel.s.size + this.sel.i.size;
      ctx.font = '11px var(--font-interface), sans-serif';
      const label = `${n}`;
      const w = ctx.measureText(label).width + 10;
      ctx.fillStyle = cssVar(this.wrap, '--interactive-accent', '#4a8');
      roundRect(ctx, ax - 3, ay - 20, w, 16, 4);
      ctx.fill();
      ctx.fillStyle = cssVar(this.wrap, '--text-on-accent', '#fff');
      ctx.fillText(label, ax + 2, ay - 8);
    }
    ctx.restore();
  }

  // ── 입력 · 두 경로 공통 ──────────────────────────────────
  // Pointer 경로와 Touch 경로가 같은 규칙을 쓰게 여기로 모은다.
  // 전에는 지우개 처리가 양쪽에 따로 적혀 있어 한쪽만 고치면 갈렸다.
  // 돌려주는 값이 true 면 「획이 아니다 — 여기서 끝」이다.

  armLong(cx, cy) {
    this.cancelLong();
    this.longAt = [cx, cy];
    this.longStart = Date.now();
    this.longT = setTimeout(() => {
      this.longT = 0;
      const r = this.live.getBoundingClientRect();
      this.openRadial(cx - r.left, cy - r.top);
    }, LONG_MS);
    this.schedule();
  }

  cancelLong() {
    if (this.longT) { clearTimeout(this.longT); this.longT = 0; }
    if (this.longAt) { this.longAt = null; this.schedule(); }
  }

  // 차오르는 링. 이게 없으면 언제 뜨는지 몰라 일찍 떼거나 오래 누른다.
  // 링이 보이는 동안 펜을 움직이면 취소되므로, 「뜨겠다」 싶을 때 피할 수 있다.
  drawHold(ctx) {
    if (!this.longT || !this.longAt) return;
    const r = this.live.getBoundingClientRect();
    const cx = this.longAt[0] - r.left, cy = this.longAt[1] - r.top;
    const p = Math.min(1, (Date.now() - this.longStart) / LONG_MS);
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = Math.min(1, p * 2.6);      // 점 찍는 짧은 접촉에는 거의 안 보인다
    ctx.strokeStyle = cssVar(this.wrap, '--background-modifier-border', '#8886');
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, 24, 0, 6.283);
    ctx.stroke();
    ctx.strokeStyle = cssVar(this.wrap, '--interactive-accent', '#4a8');
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, 24, -Math.PI / 2, -Math.PI / 2 + 6.283 * p);
    ctx.stroke();
    ctx.restore();
    this.schedule();          // 다 찰 때까지 계속 다시 그린다
  }

  // 펜을 댄 채 손가락으로 톡 — 뗄 때 연다
  fingerTapDown(t) {
    this.tap = { id: t.identifier, at: Date.now(), x: t.clientX, y: t.clientY };
  }

  fingerTapUp(t) {
    const k = this.tap;
    this.tap = null;
    if (!k || k.id !== t.identifier) return false;
    if (Date.now() - k.at > TAP_MS) return false;
    const dx = t.clientX - k.x, dy = t.clientY - k.y;
    if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) return false;
    if (!this.penPos) return false;
    const r = this.live.getBoundingClientRect();
    this.openRadial(this.penPos[0] - r.left, this.penPos[1] - r.top);
    return true;
  }

  beginPen(x, y, pr, cx, cy) {
    this.penPos = [cx, cy];
    if (this.radial) { this.radial.hit = null; return true; }   // 떠 있으면 다시 안 연다
    this.armLong(cx, cy);

    if (this.tool === 'er') { this.snapshot(); this.erasing = true; this.eraseAt(x, y); return true; }

    if (this.tool === 'sel') {
      if (this.hasSel && this.inSelBB(x, y)) {
        this.drag = { dx: 0, dy: 0, ox: x, oy: y };
        this.needBake = true;                 // 고른 것을 base 에서 뺀다
      } else {
        this.sel.s.clear(); this.sel.i.clear();
        this.lasso = [x, y];
      }
      this.schedule();
      return true;
    }

    this.cur = this.newStroke(x, y, pr);
    this.schedule();
    return true;
  }

  movePen(x, y, cx, cy) {
    this.penPos = [cx, cy];
    // 조금이라도 획을 그으려는 움직임이면 즉시 접는다
    if (this.longT && this.longAt) {
      const dx = cx - this.longAt[0], dy = cy - this.longAt[1];
      if (dx * dx + dy * dy > LONG_SLOP * LONG_SLOP) this.cancelLong();
    }
    if (this.radial) {
      const r = this.live.getBoundingClientRect();
      this.radial.hit = this.radialHit(cx - r.left, cy - r.top);
      this.schedule();
      return true;
    }
    if (this.erasing) { this.eraseAt(x, y); return true; }
    if (this.drag) {
      this.drag.dx = x - this.drag.ox;
      this.drag.dy = y - this.drag.oy;
      this.schedule();
      return true;
    }
    if (this.lasso) {
      const n = this.lasso.length;
      const dx = x - this.lasso[n - 2], dy = y - this.lasso[n - 1];
      const k = this.doc.view.k;
      if ((dx * dx + dy * dy) * k * k >= 4) this.lasso.push(x, y);
      this.schedule();
      return true;
    }
    return false;
  }

  endPen() {
    this.penPos = null;
    this.tap = null;
    this.cancelLong();
    if (this.radial) { this.closeRadial(true); return true; }
    if (this.erasing) { this.erasing = false; this.commitDoc(); return true; }
    if (this.drag) { this.dropDrag(); return true; }
    if (this.lasso) { this.selectByLasso(); return true; }
    return false;
  }

  // ── 입력 ────────────────────────────────────────────────
  // 손가락과 펜을 **한 자루에 세면 안 된다.** 손이 닿아 있는 상태에서
  // 펜을 대면 합이 2가 되어 「두 손가락 확대」로 오인한다 — 팜 리젝션이 아니라
  // 펜을 막는 것이 된다. 그래서 touches 만 따로 센다.
  tally(e, kind) {
    const c = this.counts[e.pointerType] || (this.counts[e.pointerType] = {});
    c[kind] = (c[kind] || 0) + 1;
    this.lastEv = `${e.pointerType} ${kind} btn=${e.buttons} p=${(e.pressure || 0).toFixed(2)}`;
    if (kind !== 'move') {
      this.mark(`${e.pointerType[0]}·${kind} id${e.pointerId} b${e.buttons}`);
    }
    if (this.dbg) this.paintDbg();
  }

  paintDbg() {
    if (!this.dbgEl || !this.dbg) return;
    const f = (t) => {
      const c = this.counts[t] || {};
      return `${t.padEnd(5)} down ${c.down || 0} · move ${c.move || 0} · up ${c.up || 0} · cancel ${c.cancel || 0}`;
    };
    this.dbgEl.setText(
      [`경로 ${this.useTouch ? 'Touch' : 'Pointer'}`,
       f('pen'), f('touch'), f('mouse'),
       `손가락 ${this.touches.size} · 획중 ${this.cur ? this.cur.pts.length / 3 : 0}`,
       `자가복구 ${this.recovered || 0} · 총획 ${this.doc.strokes.length}`,
       `마지막 ${this.lastEv || '-'}`,
       '── 흐름(move 제외) ──',
       (this.trace || []).join('\n')].join('\n')
    );
  }

  onDown = (e) => {
    if (this.useTouch && e.pointerType !== 'mouse') return;      // 터치 기기에서는 TouchEvent 쪽이 맡는다
    this.tally(e, 'down');
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, e);
      // 펜이 이미 그리는 중이면 손은 무시한다. 이게 진짜 팜 리젝션이다.
      if (this.cur || this.erasing) return;
      if (this.touches.size === 2) this.startPinch();
      return;
    }

    // 오른쪽·가운데 클릭은 획이 아니다. 마우스에만 걸어 스타일러스 배럴 버튼은 안 건드린다.
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // 펜·마우스는 손가락이 몇 개 닿아 있든 항상 그린다.
    this.touches.clear();
    this.pinch = null;

    this.penId = e.pointerId;
    const [x, y] = this.toWorld(e.clientX, e.clientY);
    this.beginPen(x, y, this.prOf(e.pressure), e.clientX, e.clientY);
  };

  onMove = (e) => {
    if (this.useTouch && e.pointerType !== 'mouse') return;
    if (this.dbg) this.tally(e, 'move');
    if (e.pointerType === 'touch') {
      if (!this.touches.has(e.pointerId)) return;
      this.touches.set(e.pointerId, e);
      // 펜이 그리는 중이면 손 움직임은 통째로 버린다
      if (this.cur || this.erasing) return;
      if (this.pinch) this.movePinch();
      return;
    }

    {
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      if (this.movePen(x, y, e.clientX, e.clientY)) { e.preventDefault(); return; }
    }

    // **자가 복구.** 취소가 끼어들어 획이 끊겨도, 펜이 아직 닿아 있으면(buttons≠0)
    // 여기서 다시 시작한다. 「둘째 획부터 안 그려짐」이 이 자리였다.
    if (!this.cur && e.buttons !== 0 && this.tool !== 'er' && this.tool !== 'sel' &&
        !this.radial && this.inCanvas(e)) {
      const [sx, sy] = this.toWorld(e.clientX, e.clientY);
      this.cur = this.newStroke(sx, sy, this.prOf(e.pressure));
      this.recovered = (this.recovered || 0) + 1;
    }
    if (!this.cur) return;
    e.preventDefault();

    // 240Hz 원본 점. 이게 핵심이다 — pointermove 하나에 점이 여럿 들어 있다.
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const p of evs) {
      const [x, y] = this.toWorld(p.clientX, p.clientY);
      const pr = this.prOf(p.pressure);
      const n = this.cur.pts.length;
      // 너무 촘촘하면 버린다. 화면 0.6px 미만은 눈에 안 보인다.
      if (n >= 3) {
        const dx = x - this.cur.pts[n - 3], dy = y - this.cur.pts[n - 2];
        if ((dx * dx + dy * dy) * this.doc.view.k * this.doc.view.k < 0.36) continue;
      }
      this.cur.pts.push(x, y, pr);
    }

    // 예측점은 live 에만 얹고 저장하지 않는다. 체감 지연이 줄어든다.
    this.pred = null;
    if (e.getPredictedEvents) {
      const pe = e.getPredictedEvents();
      if (pe.length) {
        this.pred = [];
        for (const p of pe) {
          const [x, y] = this.toWorld(p.clientX, p.clientY);
          this.pred.push(x, y, this.prOf(p.pressure));
        }
      }
    }
    this.schedule();
  };

  onUp = (e) => {
    if (this.useTouch && e.pointerType !== 'mouse') return;
    this.tally(e, 'up');
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      return;
    }
    if (this.endPen()) return;
    if (!this.cur) return;

    this.commitStroke();
    this.cur = null;
    this.pred = null;
    this.drawLive();
  };

  // trace 한 줄. 앞에 직전 이벤트로부터 몇 ms 지났는지를 붙인다.
  // 「down 이 안 온다」와 「down 이 늦게 온다」를 가르는 눈금이다.
  mark(s) {
    const now = performance.now();
    const d = this.lastMark == null ? 0 : now - this.lastMark;
    this.lastMark = now;
    this.trace = this.trace || [];
    this.trace.push(`${String(Math.round(d)).padStart(4)}ms ${s}`);
    if (this.trace.length > 18) this.trace.shift();
  }

  // ── TouchEvent 경로 (iPadOS) ──────────────────────────────
  // Pointer 경로는 손이 닿아 있으면 둘째 펜 접촉을 늦게 주거나 아예 안 준다.
  // WebKit 이 「제스처인가」를 판별하느라 붙들기 때문이다. TouchEvent 는 그 단계를
  // 안 거치고, Touch.touchType 으로 펜/손가락이 바로 갈린다.
  onTouch = (e, kind) => {
    const pen = [], fin = [];
    for (const t of e.changedTouches) {
      (t.touchType === 'stylus' ? pen : fin).push(t);
    }

    // **stylus 를 실제로 본 뒤에만 이 경로를 켠다.**
    // touchType 은 애플이 채워 준다. 안 채우는 하드웨어에서 무조건 켜면
    // 펜이 손가락으로 분류돼 그려지는 대신 화면이 밀린다.
    // 안 켜면 Pointer 경로가 그대로 맡고, 거기서는 pointerType === 'pen' 으로 갈린다.
    if (!this.useTouch) {
      if (!pen.length) return;
      this.useTouch = true;
    }
    // 지금 화면에 닿아 있는 펜이 있나 (changed 가 아니라 전체)
    let penLive = false;
    for (const t of e.touches) if (t.touchType === 'stylus') penLive = true;

    if (this.dbg && kind !== 'move') {
      const p0 = pen[0];
      this.mark(
        `T·${kind} pen${pen.length} fin${fin.length} live${e.touches.length}` +
        (p0 ? ` f=${(p0.force || 0).toFixed(2)}` : '')
      );
      const k2 = kind === 'start' ? 'down' : kind === 'end' ? 'up' : kind;
      if (pen.length) this.counts.pen[k2] = (this.counts.pen[k2] || 0) + pen.length;
      if (fin.length) this.counts.touch[k2] = (this.counts.touch[k2] || 0) + fin.length;
      this.paintDbg();
    }

    // ── 펜 ──
    if (pen.length) {
      e.preventDefault();
      const t0 = pen[0];
      const [x, y] = this.toWorld(t0.clientX, t0.clientY);
      const pr = this.prOf(t0.force);

      if (kind === 'start') {
        this.touches.clear();
        this.pinch = null;
        this.beginPen(x, y, pr, t0.clientX, t0.clientY);
        return;
      }

      if (kind === 'move') {
        if (this.movePen(x, y, t0.clientX, t0.clientY)) return;
        // 펜을 뗐다 대는 사이에 start 를 놓쳤어도 여기서 다시 시작한다.
        // 다만 올가미·지우개·메뉴 중에는 안 만든다 — 그 도구에서 획이 생기면 안 된다.
        if (!this.cur) {
          if (this.tool === 'er' || this.tool === 'sel' || this.radial) return;
          this.cur = this.newStroke(x, y, pr);
          this.recovered = (this.recovered || 0) + 1;
          this.schedule();
          return;
        }
        const n = this.cur.pts.length;
        const dx = x - this.cur.pts[n - 3], dy = y - this.cur.pts[n - 2];
        const k = this.doc.view.k;
        if ((dx * dx + dy * dy) * k * k >= 0.36) this.cur.pts.push(x, y, pr);
        this.schedule();
        return;
      }

      // end / cancel
      if (this.endPen()) { this.drawLive(); return; }
      this.commitStroke();
      this.cur = null;
      this.drawLive();
      return;
    }

    // ── 손가락 ──
    // 펜이 닿아 있는 동안 손가락은 팜 리젝션 대상이다. 다만 **짧게 톡**은 뜻이 있다 —
    // 그 자리에 방사형 메뉴를 연다. 뗄 때 판정하므로 얹어 둔 손바닥은 안 걸린다.
    if (penLive || this.cur || this.erasing) {
      e.preventDefault();
      if (kind === 'start' && fin.length === 1 && !this.radial) this.fingerTapDown(fin[0]);
      else if (kind === 'start') this.tap = null;          // 둘 이상이면 톡이 아니다
      else if (kind === 'move') {
        const k = this.tap;
        if (k) for (const t of fin) if (t.identifier === k.id) {
          const dx = t.clientX - k.x, dy = t.clientY - k.y;
          if (dx * dx + dy * dy > TAP_SLOP * TAP_SLOP) this.tap = null;
        }
      } else {
        for (const t of fin) if (this.fingerTapUp(t)) break;
      }
      return;
    }

    if (kind === 'start') {
      for (const t of fin) this.touches.set(t.identifier, t);
      if (this.touches.size === 2) this.startPinch();
    } else if (kind === 'move') {
      let any = false;
      for (const t of fin) if (this.touches.has(t.identifier)) { this.touches.set(t.identifier, t); any = true; }
      if (this.pinch && any) { e.preventDefault(); this.movePinch(); }
    } else {
      for (const t of fin) this.touches.delete(t.identifier);
      if (this.touches.size < 2) this.pinch = null;
    }
  };

  // pointercancel 은 up 이 아니다. 손이 닿아 있으면 iPadOS 가 펜에 이걸 던진다.
  // up 처럼 처리하면 획이 닫히고, 그다음 획이 시작을 못 한다.
  onCancel = (e) => {
    if (this.useTouch && e.pointerType !== 'mouse') return;
    this.tally(e, 'cancel');
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      return;
    }
    // 그린 만큼은 살려서 굽고, 상태만 깨끗이 비운다
    this.cancelLong();
    if (this.radial) this.closeRadial(false);
    if (this.drag) this.dropDrag();
    if (this.lasso) { this.lasso = null; this.needBake = true; }
    this.commitStroke();
    this.cur = null;
    this.pred = null;
    this.penId = null;
    this.erasing = false;
    this.drawLive();
  };

  onWheel = (e) => {
    e.preventDefault();
    const v = this.doc.view;
    if (e.ctrlKey || e.metaKey) {
      const r = this.live.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = Math.min(8, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.002)));
      v.x = mx - (mx - v.x) * (k2 / v.k);
      v.y = my - (my - v.y) * (k2 / v.k);
      v.k = k2;
    } else {
      v.x -= e.deltaX;
      v.y -= e.deltaY;
    }
    this.needBake = true;
    this.schedule();
  };

  startPinch() {
    const [a, b] = [...this.touches.values()];
    const r = this.live.getBoundingClientRect();
    this.pinch = {
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      cx: (a.clientX + b.clientX) / 2 - r.left,
      cy: (a.clientY + b.clientY) / 2 - r.top,
      v: { ...this.doc.view },
    };
  }

  movePinch() {
    if (this.touches.size !== 2) return;
    const [a, b] = [...this.touches.values()];
    const r = this.live.getBoundingClientRect();
    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const cx = (a.clientX + b.clientX) / 2 - r.left;
    const cy = (a.clientY + b.clientY) / 2 - r.top;
    const p = this.pinch, v = this.doc.view;
    const k2 = Math.min(8, Math.max(0.1, p.v.k * (d / (p.d || 1))));
    v.k = k2;
    v.x = cx - (p.cx - p.v.x) * (k2 / p.v.k);
    v.y = cy - (p.cy - p.v.y) * (k2 / p.v.k);
    this.needBake = true;
    this.schedule();
  }

  // ── 지우개 · 되돌리기 ────────────────────────────────────
  // 픽셀이 아니라 **획 단위**로 지운다. 훨씬 싸고 되돌리기가 쉽다.
  eraseAt(x, y) {
    const R = this.eraserR / this.doc.view.k;
    let hit = false;
    for (let i = this.doc.strokes.length - 1; i >= 0; i--) {
      const s = this.doc.strokes[i], b = s.bb;
      if (b && (x < b[0] - R || x > b[2] + R || y < b[1] - R || y > b[3] + R)) continue;
      const p = s.pts;
      // 점 하나짜리 획(탭 한 번)은 구간이 없어 아래 루프를 안 탄다
      if (p.length === 3) {
        const dx = x - p[0], dy = y - p[1];
        if (Math.sqrt(dx * dx + dy * dy) <= R + s.w) {
          this.doc.strokes.splice(i, 1);
          hit = true;
        }
        continue;
      }
      for (let j = 3; j + 2 < p.length; j += 3) {
        if (segDist(x, y, p[j - 3], p[j - 2], p[j], p[j + 1]) <= R + s.w) {
          this.doc.strokes.splice(i, 1);
          hit = true;
          break;
        }
      }
    }
    if (hit) { this._bb = null; this.needBake = true; this.schedule(); }
  }

  fit() {
    const v = this.doc.view;
    this._bb = null;
    const bb = this.contentBB();
    if (!bb) { v.x = 0; v.y = 0; v.k = 1; this.needBake = true; return this.schedule(); }
    const [x0, y0, x1, y1] = bb;
    const r = this.wrap.getBoundingClientRect();
    const k = Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1)) * 0.9;
    v.k = Math.min(8, Math.max(0.1, k));
    v.x = r.width / 2 - ((x0 + x1) / 2) * v.k;
    v.y = r.height / 2 - ((y0 + y1) / 2) * v.k;
    this.needBake = true;
    this.schedule();
  }

  // ── 떠 있는 팔레트 ────────────────────────────────────────
  // 제스처를 셋 시도해 셋 다 실패했다 — 그리는 것도 펜을 유리에 대는 것이라
  // 「메뉴를 열려는 접촉」과 「긋는 접촉」을 가를 근거가 없다.
  // 그래서 판정을 없앤다. 손 닿는 자리에 두고 누르면 된다.
  buildPalette() {
    const pal = this.pal = this.wrap.createDiv({ cls: 'quire-pal' });
    const grip = pal.createDiv({ cls: 'quire-grip', attr: { 'aria-label': 'Drag to move' } });
    grip.setText('⠿');

    const tools = pal.createDiv({ cls: 'quire-prow' });
    this.palTool = {};
    for (const [k, s, title] of [['pen','✏️','Pen'], ['hl','🖍','Highlighter'],
                                 ['er','🩹','Eraser'], ['sel','⬚','Select']]) {
      const b = tools.createEl('button', { text: s, attr: { 'aria-label': title, title } });
      b.onclick = () => this.setTool(k);
      this.palTool[k] = b;
    }

    const ws = pal.createDiv({ cls: 'quire-prow' });
    this.palW = [];
    for (const w of WIDTHS) {
      const d = ws.createDiv({ cls: 'quire-w', attr: { 'aria-label': `Width ${w}`, title: `Width ${w}` } });
      d.dataset.w = String(w);
      const dot = d.createDiv({ cls: 'quire-wdot' });
      const px = Math.min(16, 3 + w * 1.7);
      dot.style.width = dot.style.height = `${px}px`;
      d.onclick = () => this.setWidth(w);
      this.palW.push(d);
    }

    const cs = pal.createDiv({ cls: 'quire-prow quire-prow-c' });
    this.palC = [];
    for (const c of PALETTE) {
      const d = cs.createDiv({ cls: 'quire-sw', attr: { 'aria-label': c, title: c } });
      d.dataset.color = c;
      d.style.background = c;
      d.onclick = () => this.setColor(c);
      this.palC.push(d);
    }

    // 끌어 옮기기. grip 에서만 잡는다 — 버튼을 끌면 캔버스가 아니라 팔레트가 움직여 헷갈린다.
    let drag = null;
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = pal.getBoundingClientRect(), w = this.wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, w };
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      this.movePalette(e.clientX - drag.dx - drag.w.left, e.clientY - drag.dy - drag.w.top);
    });
    const up = (e) => {
      if (!drag) return;
      drag = null;
      const s = this.plugin.settings;
      s.palX = parseFloat(pal.style.left) || 0;
      s.palY = parseFloat(pal.style.top) || 0;
      this.plugin.queueSave();
      e.stopPropagation();
    };
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);

    // 팔레트 위에서는 캔버스가 그리지 않게 막는다
    for (const ev of ['pointerdown', 'touchstart']) {
      pal.addEventListener(ev, (e) => e.stopPropagation(), { passive: false });
    }

    const s = this.plugin.settings;
    this.movePalette(s.palX != null ? s.palX : 16, s.palY != null ? s.palY : 96);
    this.setPalette(this.palOn);
  }

  // 화면 밖으로 나가면 못 되찾는다. 항상 안쪽으로 물린다.
  movePalette(x, y) {
    if (!this.pal) return;
    const w = this.wrap.getBoundingClientRect();
    const r = this.pal.getBoundingClientRect();
    const pw = r.width || 148, ph = r.height || 132;
    const nx = Math.max(4, Math.min(x, Math.max(4, w.width - pw - 4)));
    const ny = Math.max(4, Math.min(y, Math.max(4, w.height - ph - 4)));
    this.pal.style.left = nx + 'px';
    this.pal.style.top = ny + 'px';
  }

  setPalette(on) {
    this.palOn = on;
    this.plugin.settings.palOn = on;
    this.plugin.queueSave();
    if (this.pal) this.pal.style.display = on ? 'flex' : 'none';
    this.refreshBar();
  }

  // ── 방사형 메뉴 ──────────────────────────────────────────
  // 애플펜슬의 더블탭·스퀴즈는 WebKit 이 웹에 안 넘긴다. 그래서 「꾹 누름」으로 받는다.
  // 툴바까지 손이 올라가지 않게 하는 것이 목적이라, 메뉴는 누른 자리에 뜬다.
  radialItems() {
    const tools = [
      { k: 'tool', v: 'pen', t: '✏️' }, { k: 'tool', v: 'hl', t: '🖍' },
      { k: 'tool', v: 'er', t: '🩹' }, { k: 'tool', v: 'sel', t: '⬚' },
    ];
    const outer = [];
    for (const c of PALETTE) outer.push({ k: 'color', v: c });
    for (const w of WIDTHS) outer.push({ k: 'width', v: w });
    return { inner: tools, outer };
  }

  openRadial(cx, cy) {
    // 메뉴가 뜨면 그리던 획은 획이 아니다. 버린다.
    this.cur = null;
    this.pred = null;
    // 누르고 있던 동작도 같이 끝낸다. 안 끝내면 메뉴를 닫은 뒤에도
    // erasing 이 켜진 채로 남아 펜을 움직일 때마다 획이 지워진다.
    if (this.erasing) this.erasing = false;
    if (this.drag) this.dropDrag();
    if (this.lasso) { this.lasso = null; this.needBake = true; }
    this.radial = { cx, cy, hit: null };
    this.schedule();
  }

  // 화면 좌표 → 어느 칸인가. 반지름으로 안·바깥 고리를 가른다.
  radialHit(cx, cy) {
    const R = this.radial;
    if (!R) return null;
    const dx = cx - R.cx, dy = cy - R.cy;
    const r = Math.hypot(dx, dy);
    if (r < 26) return null;                       // 가운데는 취소
    const { inner, outer } = this.radialItems();
    let a = Math.atan2(dy, dx) + Math.PI / 2;      // 12시를 0 으로
    a = ((a % 6.283185) + 6.283185) % 6.283185;
    if (r < 74) {
      const i = Math.floor((a / 6.283185) * inner.length) % inner.length;
      return inner[i];
    }
    if (r < 116) {
      const i = Math.floor((a / 6.283185) * outer.length) % outer.length;
      return outer[i];
    }
    return null;                                    // 바깥으로 끌면 취소
  }

  applyRadial(it) {
    if (!it) return;
    if (it.k === 'tool') this.setTool(it.v);
    else if (it.k === 'color') this.setColor(it.v);
    else if (it.k === 'width') this.setWidth(it.v);
  }

  closeRadial(apply) {
    if (!this.radial) return;
    const hit = this.radial.hit;
    this.radial = null;
    if (apply) this.applyRadial(hit);
    this.schedule();
  }

  drawRadial(ctx) {
    const R = this.radial;
    if (!R) return;
    const d = this.dpr;
    const { inner, outer } = this.radialItems();
    ctx.save();
    ctx.setTransform(d, 0, 0, d, 0, 0);

    const bg = cssVar(this.wrap, '--background-secondary', '#222');
    const bd = cssVar(this.wrap, '--background-modifier-border', '#888');
    const acc = cssVar(this.wrap, '--interactive-accent', '#4a8');

    const ring = (r0, r1, items, i, on) => {
      const a0 = (i / items.length) * 6.283185 - Math.PI / 2;
      const a1 = ((i + 1) / items.length) * 6.283185 - Math.PI / 2;
      ctx.beginPath();
      ctx.arc(R.cx, R.cy, r1, a0, a1);
      ctx.arc(R.cx, R.cy, r0, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = on ? acc : bg;
      ctx.globalAlpha = on ? 0.95 : 0.88;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = bd;
      ctx.lineWidth = 1;
      ctx.stroke();
      return [(a0 + a1) / 2, (r0 + r1) / 2];
    };
    const same = (a, b) => a && b && a.k === b.k && a.v === b.v;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < inner.length; i++) {
      const it = inner[i];
      const [am, rm] = ring(28, 72, inner, i, same(R.hit, it) || it.v === this.tool);
      ctx.font = '19px sans-serif';
      ctx.fillStyle = cssVar(this.wrap, '--text-normal', '#eee');
      ctx.fillText(it.t, R.cx + Math.cos(am) * rm, R.cy + Math.sin(am) * rm);
    }
    for (let i = 0; i < outer.length; i++) {
      const it = outer[i];
      const [am, rm] = ring(76, 114, outer, i,
        same(R.hit, it) || (it.k === 'color' ? it.v === this.color : it.v === this.width));
      const px = R.cx + Math.cos(am) * rm, py = R.cy + Math.sin(am) * rm;
      if (it.k === 'color') {
        ctx.beginPath();
        ctx.arc(px, py, 9, 0, 6.284);
        ctx.fillStyle = it.v;
        ctx.fill();
        ctx.strokeStyle = bd;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(px, py, Math.min(9, 2 + it.v * 1.0), 0, 6.284);
        ctx.fillStyle = cssVar(this.wrap, '--text-normal', '#eee');
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ── 올가미 · 이동 ────────────────────────────────────────
  // 완전히 안에 든 것만 고른다. 걸친 것까지 고르면 무엇이 잡혔는지 예측이 안 된다.
  selectByLasso() {
    const poly = this.lasso;
    this.sel.s.clear(); this.sel.i.clear();
    if (poly && poly.length >= 6) {
      for (let i = 0; i < this.doc.strokes.length; i++) {
        const p = this.doc.strokes[i].pts;
        let all = true;
        for (let j = 0; j < p.length; j += 3) {
          if (!pointInPoly(p[j], p[j + 1], poly)) { all = false; break; }
        }
        if (all && p.length) this.sel.s.add(i);
      }
      for (let i = 0; i < this.doc.images.length; i++) {
        const m = this.doc.images[i];
        const c = [[m.x, m.y], [m.x + m.w, m.y], [m.x, m.y + m.h], [m.x + m.w, m.y + m.h]];
        if (c.every(([x, y]) => pointInPoly(x, y, poly))) this.sel.i.add(i);
      }
    }
    this.lasso = null;
    this.needBake = true;
    this.schedule();
  }

  inSelBB(x, y) {
    const bb = this.selBB();
    if (!bb) return false;
    const pad = 8 / this.doc.view.k;
    return x >= bb[0] - pad && x <= bb[2] + pad && y >= bb[1] - pad && y <= bb[3] + pad;
  }

  dropDrag() {
    const d = this.drag;
    this.drag = null;
    if (!d || (d.dx === 0 && d.dy === 0)) { this.needBake = true; return this.schedule(); }
    this.snapshot();
    // pts 를 고치므로 얕은 복사로는 이력이 같이 움직인다. 고칠 것만 새로 만든다.
    for (const i of this.sel.s) {
      const s = this.doc.strokes[i];
      if (!s) continue;
      const p = s.pts.slice();
      for (let j = 0; j < p.length; j += 3) { p[j] += d.dx; p[j + 1] += d.dy; }
      const n = Object.assign({}, s, { pts: p });
      n.bb = bboxOf(p, n.w);
      this.doc.strokes[i] = n;
    }
    for (const i of this.sel.i) {
      const m = this.doc.images[i];
      if (!m) continue;
      this.doc.images[i] = Object.assign({}, m, { x: m.x + d.dx, y: m.y + d.dy });
    }
    this._bb = null;
    this.needBake = true;
    this.schedule();
    this.commitDoc();
  }

  deleteSel() {
    if (!this.hasSel) return;
    this.snapshot();
    this.doc.strokes = this.doc.strokes.filter((_, i) => !this.sel.s.has(i));
    this.doc.images = this.doc.images.filter((_, i) => !this.sel.i.has(i));
    this.sel.s.clear(); this.sel.i.clear();
    this._bb = null;
    this.needBake = true;
    this.schedule();
    this.commitDoc();
  }

  // ── 이미지 ──────────────────────────────────────────────
  // 볼트 첨부로 두고 경로만 문서에 적는다. 데이터 URI 로 박으면 파일이
  // 수십 MB 가 되고 이력 한 칸마다 그만큼이 복사된다.
  imgFor(im) {
    let el = this._img.get(im.src);
    if (el) return el;
    el = new Image();
    el.onload = () => { this.needBake = true; this.schedule(); };
    el.onerror = () => { /* 자리 표시로 남는다 */ };
    let url = im.src;
    if (!/^(data:|https?:|app:|blob:)/.test(url)) {
      const f = this.app.vault.getAbstractFileByPath(url);
      url = f ? this.app.vault.getResourcePath(f) : url;
    }
    el.src = url;
    this._img.set(im.src, el);
    return el;
  }

  // 화면 가운데에 놓는다. 긴 변이 화면의 절반을 안 넘게 줄인다.
  placeImage(src, natW, natH, attr) {
    const r = this.wrap.getBoundingClientRect();
    const v = this.doc.view;
    const maxW = (r.width * 0.5) / v.k, maxH = (r.height * 0.5) / v.k;
    let w = natW || 320, h = natH || 240;
    const s = Math.min(1, maxW / w, maxH / h);
    w *= s; h *= s;
    const [cx, cy] = this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
    this.snapshot();
    this.doc.images.push({ id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
                           src, x: cx - w / 2, y: cy - h / 2, w, h, attr: attr || undefined });
    this._bb = null;
    this.needBake = true;
    this.schedule();
    this.commitDoc();
  }

  // 볼트에 바이트를 넣고 그 경로를 돌려준다. 첨부 위치는 볼트 설정을 그대로 탄다.
  async saveAttachment(name, buf) {
    const fm = this.app.fileManager;
    const base = this.file ? this.file.path : '';
    let path = fm && fm.getAvailablePathForAttachment
      ? await fm.getAvailablePathForAttachment(name, base)
      : name;
    const f = await this.app.vault.createBinary(path, buf);
    return f.path;
  }

  async addFromBlob(name, buf, attr) {
    try {
      const path = await this.saveAttachment(name, buf);
      const el = new Image();
      const done = () => this.placeImage(path, el.naturalWidth, el.naturalHeight, attr);
      el.onload = done;
      el.onerror = () => this.placeImage(path, 320, 240, attr);
      const f = this.app.vault.getAbstractFileByPath(path);
      el.src = f ? this.app.vault.getResourcePath(f) : path;
    } catch (e) {
      new Notice('Quire — could not save the image: ' + (e && e.message ? e.message : e));
    }
  }

  pickImage() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      this.addFromBlob(f.name, await f.arrayBuffer());
    };
    inp.click();
  }

  commitDoc() {
    if (this.readonly) return;
    this.requestSave();   // TextFileView 가 더티 표시·저장을 맡는다
  }
}

// ── 이미지 검색 ────────────────────────────────────────────
// Openverse — 키가 필요 없고 결과가 전부 CC·퍼블릭 도메인이다.
// 구글·빙은 유료 키가 필요하고 저작권 확인이 안 된다. 그래서 여기로 왔다.
// 가져온 그림에는 출처를 같이 박는다 — CC 는 표시가 조건이다.
const OV = 'https://api.openverse.org/v1/images/';

class ImageSearch extends Modal {
  constructor(app, view) {
    super(app);
    this.view = view;
    this.busy = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('quire-search');
    contentEl.createEl('h3', { text: 'Insert an image' });
    contentEl.createEl('p', { cls: 'quire-hint',
      text: 'Openverse — Creative Commons and public domain. The credit line is stored with the image.' });

    const row = contentEl.createDiv({ cls: 'quire-srow' });
    this.input = row.createEl('input', { type: 'text', attr: { placeholder: 'nurse, hospital ward, anatomy…' } });
    const go = row.createEl('button', { text: 'Search' });
    go.onclick = () => this.run();
    this.input.onkeydown = (e) => { if (e.key === 'Enter') this.run(); };

    this.status = contentEl.createDiv({ cls: 'quire-hint' });
    this.grid = contentEl.createDiv({ cls: 'quire-grid' });
    setTimeout(() => this.input.focus(), 20);
  }

  async run() {
    const q = (this.input.value || '').trim();
    if (!q || this.busy) return;
    this.busy = true;
    this.grid.empty();
    this.status.setText('Searching…');
    try {
      const url = `${OV}?q=${encodeURIComponent(q)}&page_size=24&mature=false`;
      const r = await requestUrl({ url, throw: false });
      if (r.status !== 200) throw new Error(`Openverse returned ${r.status}`);
      const res = (r.json && r.json.results) || [];
      this.status.setText(res.length ? `${res.length} results` : 'Nothing found.');
      for (const it of res) this.card(it);
    } catch (e) {
      // 왜 안 됐는지 그대로 보여 준다. 「검색 실패」만 뜨면 망인지 질의인지 모른다.
      this.status.setText('Could not search — ' + (e && e.message ? e.message : String(e)));
    } finally {
      this.busy = false;
    }
  }

  card(it) {
    const c = this.grid.createDiv({ cls: 'quire-card' });
    const img = c.createEl('img');
    img.src = it.thumbnail || it.url;
    img.loading = 'lazy';
    const who = it.creator ? `${it.creator}` : 'Unknown';
    const lic = (it.license || '').toUpperCase() + (it.license_version ? ' ' + it.license_version : '');
    c.createDiv({ cls: 'quire-cap', text: `${who} · ${lic}` });
    c.setAttr('title', `${it.title || ''}\n${who} · ${lic}`);
    c.onclick = () => this.take(it, who, lic);
  }

  async take(it, who, lic) {
    this.status.setText('Downloading…');
    try {
      const r = await requestUrl({ url: it.url, throw: false });
      if (r.status !== 200) throw new Error(`Download returned ${r.status}`);
      const ext = (it.url.split('?')[0].match(/\.(jpe?g|png|gif|webp|svg)$/i) || [, 'jpg'])[1];
      const safe = (it.title || 'image').replace(/[\\/:*?"<>|]/g, '').slice(0, 48).trim() || 'image';
      await this.view.addFromBlob(`${safe}.${ext}`, r.arrayBuffer, `${who} · ${lic} · Openverse`);
      this.close();
    } catch (e) {
      this.status.setText('Could not download — ' + (e && e.message ? e.message : String(e)));
    }
  }

  onClose() { this.contentEl.empty(); }
}

const DEFAULT_SETTINGS = { tool: 'pen', color: PALETTE[0], width: WIDTHS[1], pressure: true,
                           grid: 'dot', map: true, palOn: true, palX: null, palY: null };

module.exports = class Quire extends Plugin {
  async onload() {
    // 뷰가 생성자에서 읽으므로 registerView 보다 먼저 실어 둔다
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new QuireView(leaf, this));
    this.registerExtensions([EXT], VIEW_TYPE);

    // 왼쪽 리본 아이콘 — 명령 팔레트만 있으면 안 보인다
    this.addRibbonIcon('pencil', 'New whiteboard', () => this.create());

    this.addCommand({
      id: 'new-board',
      name: 'New whiteboard',
      callback: () => this.create(),
    });

    // 폴더·파일 오른쪽 클릭 → 그 자리에 만든다
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, item) => {
        const dir = item.children ? item.path : (item.parent?.path ?? '');
        menu.addItem((mi) =>
          mi.setTitle('New whiteboard').setIcon('pencil').onClick(() => this.create(dir))
        );
      })
    );
  }

  // dir 를 안 주면 지금 열린 파일이 있는 폴더, 그것도 없으면 볼트 루트
  async create(dir) {
    const folder = dir != null
      ? dir
      : (this.app.workspace.getActiveFile()?.parent?.path ?? '');
    const stamp = window.moment().format('YYYYMMDD-HHmmss');
    let path = (folder && folder !== '/' ? folder + '/' : '') + `board-${stamp}.${EXT}`;
    // 같은 초에 두 번 눌러도 안 겹치게
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = path.replace(new RegExp(`(-\\d+)?\\.${EXT}$`), `-${n++}.${EXT}`);
    }
    const f = await this.app.vault.create(path, JSON.stringify(DEFAULT()));
    await this.app.workspace.getLeaf(true).openFile(f);
    return f;
  }

  // 획을 그을 때마다 디스크를 때리지 않게 묶는다
  queueSave() {
    if (this.saveT) clearTimeout(this.saveT);
    this.saveT = setTimeout(() => { this.saveT = 0; this.saveData(this.settings); }, 600);
  }

  onunload() {
    if (this.saveT) { clearTimeout(this.saveT); this.saveData(this.settings); }
  }
};
