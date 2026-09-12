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

const { ItemView, TextFileView, Plugin, Notice, Menu } = require('obsidian');

const VIEW_TYPE = 'quire';
const EXT = 'quire';

const DEFAULT = () => ({ v: 1, strokes: [], view: { x: 0, y: 0, k: 1 } });

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
  const p = s.pts;
  if (p.length < 6) {
    if (p.length === 3) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(0.35, s.w * p[2] * 0.5), 0, 6.284);
      ctx.fillStyle = s.c;
      ctx.fill();
    }
    return;
  }
  ctx.strokeStyle = s.c;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = s.a != null ? s.a : 1;

  // 필압을 굵기로. 구간마다 굵기가 달라지므로 구간별로 그린다.
  for (let i = 3; i + 2 < p.length; i += 3) {
    const x0 = p[i - 3], y0 = p[i - 2];
    const x1 = p[i], y1 = p[i + 1], pr = p[i + 2];
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x0, y0, mx, my);
    ctx.lineWidth = Math.max(0.35 / k, s.w * (0.35 + 0.65 * pr));
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(x1, y1);
    ctx.lineWidth = Math.max(0.35 / k, s.w * (0.35 + 0.65 * pr));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

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
    this.tool = 'pen';
    this.color = '#2f6de0';
    this.width = 2.2;
    this.eraserR = 12;
    this.cur = null;          // 그리는 중인 획
    this.needBake = true;     // base 를 다시 구워야 하나
    this.raf = 0;
    this.touches = new Map();   // 손가락만. 펜은 절대 여기 안 들어간다
    this.pinch = null;
  }

  getViewType() { return VIEW_TYPE; }
  getIcon() { return 'pencil'; }
  getDisplayText() { return this.file ? this.file.basename : 'Quire'; }

  // ── 파일 ↔ 메모리 ────────────────────────────────────────
  getViewData() { return JSON.stringify(this.doc); }

  setViewData(data, clear) {
    try {
      const d = data && data.trim() ? JSON.parse(data) : DEFAULT();
      this.doc = d && Array.isArray(d.strokes) ? d : DEFAULT();
    } catch (e) {
      // 깨진 파일을 빈 것으로 덮으면 내용이 날아간다. 열지 않고 알린다.
      new Notice('Quire — could not read this file. It will not be overwritten.');
      this.doc = DEFAULT();
      this.readonly = true;
    }
    if (!this.doc.view) this.doc.view = { x: 0, y: 0, k: 1 };
    this.needBake = true;
    this.resize();
  }

  clear() { this.doc = DEFAULT(); this.needBake = true; }

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

    this.winDown = (e) => {
      const r = this.live.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right ||
          e.clientY < r.top || e.clientY > r.bottom) return;
      this.onDown(e);
    };
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
  }

  buildToolbar(root) {
    const bar = root.createDiv({ cls: 'quire-bar' });
    const btn = (label, title, fn, key) => {
      const b = bar.createEl('button', { text: label, attr: { 'aria-label': title } });
      b.onclick = fn;
      if (key) b.dataset.tool = key;
      return b;
    };
    this.penBtn = btn('✏️', 'Pen', () => this.setTool('pen'), 'pen');
    this.hlBtn = btn('🖍', 'Highlighter', () => this.setTool('hl'), 'hl');
    this.erBtn = btn('🩹', 'Eraser (whole stroke)', () => this.setTool('er'), 'er');
    btn('↩︎', 'Remove last stroke', () => this.undo());
    bar.createSpan({ cls: 'quire-sep' });
    for (const c of ['#2f6de0', '#e03131', '#2f9e44', '#f08c00', '#343a40']) {
      const d = bar.createDiv({ cls: 'quire-sw' });
      d.style.background = c;
      d.onclick = () => { this.color = c; this.setTool(this.tool === 'er' ? 'pen' : this.tool); };
    }
    bar.createSpan({ cls: 'quire-sep' });
    btn('⊙', 'Fit to content', () => this.fit());
    btn('🐞', 'Toggle input diagnostics', () => {
      this.dbg = !this.dbg;
      this.dbgEl.style.display = this.dbg ? 'block' : 'none';
      this.paintDbg();
    });
    this.dbgEl = this.wrap.createDiv({ cls: 'quire-dbg' });
    this.dbgEl.style.display = 'none';
    this.counts = { pen: {}, touch: {}, mouse: {} };
    this.setTool('pen');
  }

  setTool(t) {
    this.tool = t;
    for (const b of [this.penBtn, this.hlBtn, this.erBtn]) {
      b.toggleClass('is-on', b.dataset.tool === t);
    }
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
    this.applyXform(ctx);

    const v = this.doc.view;
    const r = this.wrap.getBoundingClientRect();
    // 화면 밖 획은 건너뛴다 — 무한 캔버스에서 이게 없으면 다시 굽는 값이 계속 커진다.
    const vx0 = -v.x / v.k, vy0 = -v.y / v.k;
    const vx1 = (r.width - v.x) / v.k, vy1 = (r.height - v.y) / v.k;

    let drawn = 0;
    for (const s of this.doc.strokes) {
      const b = s.bb;
      if (b && (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1)) continue;
      drawStroke(ctx, s, v.k);
      drawn++;
    }
    this.lastDrawn = drawn;
    this.needBake = false;
  }

  // 그리는 중인 획만. 매 프레임 돌아도 싸다.
  drawLive() {
    const ctx = this.lctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (!this.cur) return;
    this.applyXform(ctx);
    drawStroke(ctx, this.cur, this.doc.view.k);
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

    // 펜·마우스는 손가락이 몇 개 닿아 있든 항상 그린다.
    this.touches.clear();
    this.pinch = null;

    this.penId = e.pointerId;
    const [x, y] = this.toWorld(e.clientX, e.clientY);

    if (this.tool === 'er') { this.erasing = true; this.eraseAt(x, y); return; }

    const hl = this.tool === 'hl';
    this.cur = {
      c: this.color,
      w: hl ? this.width * 6 : this.width,
      a: hl ? 0.35 : 1,
      pts: [x, y, e.pressure > 0 ? e.pressure : 0.5],
    };
    this.schedule();
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

    if (this.erasing) {
      const [x, y] = this.toWorld(e.clientX, e.clientY);
      this.eraseAt(x, y);
      return;
    }

    // **자가 복구.** 취소가 끼어들어 획이 끊겨도, 펜이 아직 닿아 있으면(buttons≠0)
    // 여기서 다시 시작한다. 「둘째 획부터 안 그려짐」이 이 자리였다.
    if (!this.cur && e.buttons !== 0 && this.tool !== 'er') {
      const [sx, sy] = this.toWorld(e.clientX, e.clientY);
      const hl2 = this.tool === 'hl';
      this.cur = {
        c: this.color,
        w: hl2 ? this.width * 6 : this.width,
        a: hl2 ? 0.35 : 1,
        pts: [sx, sy, e.pressure > 0 ? e.pressure : 0.5],
      };
      this.recovered = (this.recovered || 0) + 1;
    }
    if (!this.cur) return;
    e.preventDefault();

    // 240Hz 원본 점. 이게 핵심이다 — pointermove 하나에 점이 여럿 들어 있다.
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const p of evs) {
      const [x, y] = this.toWorld(p.clientX, p.clientY);
      const pr = p.pressure > 0 ? p.pressure : 0.5;
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
          this.pred.push(x, y, p.pressure > 0 ? p.pressure : 0.5);
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
    if (this.erasing) { this.erasing = false; this.commitDoc(); return; }
    if (!this.cur) return;

    if (this.cur.pts.length >= 3) {
      this.cur.bb = bboxOf(this.cur.pts, this.cur.w);
      this.doc.strokes.push(this.cur);
      // 끝난 획을 base 에 한 번만 굽는다. 전체 재굽기가 아니다.
      this.applyXform(this.bctx);
      drawStroke(this.bctx, this.cur, this.doc.view.k);
      this.commitDoc();
    }
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
    this.useTouch = true;
    const pen = [], fin = [];
    for (const t of e.changedTouches) {
      (t.touchType === 'stylus' ? pen : fin).push(t);
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
      const pr = t0.force > 0 ? Math.min(1, t0.force) : 0.5;

      if (kind === 'start') {
        this.touches.clear();
        this.pinch = null;
        if (this.tool === 'er') { this.erasing = true; this.eraseAt(x, y); return; }
        const hl = this.tool === 'hl';
        this.cur = {
          c: this.color,
          w: hl ? this.width * 6 : this.width,
          a: hl ? 0.35 : 1,
          pts: [x, y, pr],
        };
        this.schedule();
        return;
      }

      if (kind === 'move') {
        if (this.erasing) { this.eraseAt(x, y); return; }
        // 펜을 뗐다 대는 사이에 start 를 놓쳤어도 여기서 다시 시작한다
        if (!this.cur) {
          const hl = this.tool === 'hl';
          this.cur = { c: this.color, w: hl ? this.width * 6 : this.width,
                       a: hl ? 0.35 : 1, pts: [x, y, pr] };
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
      if (this.erasing) { this.erasing = false; this.commitDoc(); return; }
      if (this.cur && this.cur.pts.length >= 6) {
        this.cur.bb = bboxOf(this.cur.pts, this.cur.w);
        this.doc.strokes.push(this.cur);
        this.applyXform(this.bctx);
        drawStroke(this.bctx, this.cur, this.doc.view.k);
        this.commitDoc();
      }
      this.cur = null;
      this.drawLive();
      return;
    }

    // ── 손가락 ── 펜이 닿아 있으면 통째로 무시(팜 리젝션)
    if (penLive || this.cur || this.erasing) { e.preventDefault(); return; }

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
    if (this.cur && this.cur.pts.length >= 6) {
      this.cur.bb = bboxOf(this.cur.pts, this.cur.w);
      this.doc.strokes.push(this.cur);
      this.applyXform(this.bctx);
      drawStroke(this.bctx, this.cur, this.doc.view.k);
      this.commitDoc();
    }
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
      for (let j = 3; j + 2 < p.length; j += 3) {
        if (segDist(x, y, p[j - 3], p[j - 2], p[j], p[j + 1]) <= R + s.w) {
          this.doc.strokes.splice(i, 1);
          hit = true;
          break;
        }
      }
    }
    if (hit) { this.needBake = true; this.schedule(); }
  }

  undo() {
    if (!this.doc.strokes.length) return;
    this.doc.strokes.pop();
    this.needBake = true;
    this.schedule();
    this.commitDoc();
  }

  fit() {
    const ss = this.doc.strokes;
    const v = this.doc.view;
    if (!ss.length) { v.x = 0; v.y = 0; v.k = 1; this.needBake = true; return this.schedule(); }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of ss) {
      const b = s.bb || bboxOf(s.pts, s.w);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    const r = this.wrap.getBoundingClientRect();
    const k = Math.min(r.width / (x1 - x0 || 1), r.height / (y1 - y0 || 1)) * 0.9;
    v.k = Math.min(8, Math.max(0.1, k));
    v.x = r.width / 2 - ((x0 + x1) / 2) * v.k;
    v.y = r.height / 2 - ((y0 + y1) / 2) * v.k;
    this.needBake = true;
    this.schedule();
  }

  commitDoc() {
    if (this.readonly) return;
    this.requestSave();   // TextFileView 가 더티 표시·저장을 맡는다
  }
}

module.exports = class Quire extends Plugin {
  async onload() {
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

  onunload() {}
};
