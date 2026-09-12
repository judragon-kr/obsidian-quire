// 스텁 Obsidian 위에서 플러그인을 실제로 띄워 확인한다.
// 브라우저가 없으므로 픽셀은 못 보지만, 아래 것들은 전부 잡힌다 —
// 메서드 중복 정의 · 잘못된 문자열 이스케이프 · 상태가 파일 경계를 넘는 것.
//   node test/smoke.js
const Module = require('module');
const path = require('path');
const STUB = path.join(__dirname, 'stub-obsidian.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  return req === 'obsidian' ? STUB : orig.call(this, req, ...rest);
};
const ob = require(STUB);
global.window = { devicePixelRatio: 2, addEventListener(){}, removeEventListener(){},
                  moment: () => ({ format: () => '20260912-000000' }),
                  requestAnimationFrame: (f)=>{ return 1; }, cancelAnimationFrame(){} };
global.requestAnimationFrame = (f)=>1; global.cancelAnimationFrame = ()=>{};
global.ResizeObserver = class { observe(){} disconnect(){} };
global.performance = { now: () => 0 };

const Quire = require(path.join(__dirname, '..', 'main.js'));
const p = new Quire();
(async () => {
  await p.onload();
  const View = p.views['quire'];
  const v = View({});
  v.wrap = ob.__mkEl('div');            // resize() 가 쓰는 것들
  await v.onOpen();

  const GRIDS_NEXT = (g) => ({ off:'dot', dot:'line', line:'off' })[g];
  const fail = [];
  const ok = (c, m) => { console.log(`  ${c ? '○' : '✗'} ${m}`); if (!c) fail.push(m); };

  // ── A. undo 가 하나인가 ──
  const names = Object.getOwnPropertyNames(Object.getPrototypeOf(v));
  ok(v.undo.toString().includes('redoStack'), 'undo 는 스택 기반이다');
  ok(v.redo.toString().includes('undoStack'), 'redo 가 살아 있다');

  // ── B. 버튼 글자가 이스케이프 잔해가 아닌가 ──
  const bar = v.contentEl.children.find(c => c.classes.has('quire-bar'));
  const labels = bar.children.filter(c => c.tag === 'button').map(c => c._text);
  console.log('     버튼:', JSON.stringify(labels));
  ok(!labels.some(s => /^U000/.test(s)), '버튼에 U000… 잔해가 없다');

  // ── C. readonly 가 파일마다 초기화되나 ──
  v.setViewData('{ 깨진', false);
  ok(v.readonly === true, '깨진 파일에서 readonly=true');
  v.setViewData(JSON.stringify({ v:1, strokes:[], view:{x:0,y:0,k:1} }), false);
  ok(v.readonly === false, '멀쩡한 파일을 열면 readonly 가 풀린다');
  v.saves = 0; v.commitDoc();
  ok(v.saves === 1, '그 뒤 저장이 실제로 요청된다');

  // ── D. 이력이 파일 경계에서 끊기나 ──
  v.doc.strokes = [{c:'#000',w:2,a:1,pts:[0,0,1, 10,10,1]}];
  v.snapshot();
  v.setViewData(JSON.stringify({ v:1, strokes:[], view:{x:0,y:0,k:1} }), false);
  ok(v.undoStack.length === 0, '파일을 바꾸면 undo 이력이 비워진다');

  // ── A2. undo/redo 왕복 ──
  v.doc.strokes = [];
  v.cur = { c:'#000', w:2, a:1, pts:[0,0,1, 5,5,1] };  v.commitStroke();
  v.cur = { c:'#000', w:2, a:1, pts:[9,9,1, 12,12,1] }; v.commitStroke();
  ok(v.doc.strokes.length === 2, '획 둘이 확정된다');
  v.undo();  ok(v.doc.strokes.length === 1, 'undo 로 하나 줄어든다');
  v.redo();  ok(v.doc.strokes.length === 2, 'redo 로 되돌아온다');

  // ── F. 점 하나짜리 획을 지울 수 있나 ──
  v.doc.strokes = [{c:'#000',w:2,a:1,pts:[50,50,1], bb:[48,48,52,52]}];
  v.eraseAt(50, 50);
  ok(v.doc.strokes.length === 0, '한 점짜리 획이 지워진다');

  // ── E. 지우개에서 색을 고르면 설정도 pen ──
  v.setTool('er'); v.setColor('#e03131');
  ok(p.settings.tool === 'pen', '색을 고르면 저장되는 도구도 pen 이 된다');

  // ── I. 색 입력이 따라오나 ──
  ok(v.customInput.value === '#e03131', '커스텀 색 입력이 현재 색을 반영한다');

  // ── H. 오른쪽 클릭이 획을 안 만드나 ──
  v.doc.strokes = []; v.cur = null;
  v.onDown({ pointerType:'mouse', button:2, buttons:2, clientX:100, clientY:100, pressure:0, preventDefault(){} });
  ok(v.cur === null, '오른쪽 클릭은 획을 시작하지 않는다');
  v.onDown({ pointerType:'mouse', button:0, buttons:1, clientX:100, clientY:100, pressure:0, preventDefault(){} });
  ok(v.cur !== null, '왼쪽 클릭은 획을 시작한다');

  // ── G. 캔버스 밖 자가복구가 막히나 ──
  v.cur = null;
  v.onMove({ pointerType:'mouse', buttons:1, clientX:100, clientY:5000, pressure:0.5, preventDefault(){}, getCoalescedEvents:null });
  ok(v.cur === null, '캔버스 밖에서는 자가복구가 안 걸린다');

  // ── 격자 ──
  ok(v.grid === 'dot', '격자 기본값은 점');
  v.setGrid('line'); ok(p.settings.grid === 'line', '격자 설정이 저장된다');
  const cyc = [];
  v.setGrid('off');
  for (let i = 0; i < 4; i++) { cyc.push(v.grid); v.setGrid(GRIDS_NEXT(v.grid)); }
  ok(cyc.join('>') === 'off>dot>line>off', `격자가 off>dot>line 로 돈다 (${cyc.join('>')})`);

  // ── 실제로 그려지나 ── 세 모드 × 획 있음/없음
  const C = ob.__ctx;
  v.doc.strokes = [];
  for (const g of ['off', 'dot', 'line']) {
    v.grid = g;
    for (const withStrokes of [false, true]) {
      v.doc.strokes = withStrokes
        ? [{ c:'#000', w:2, a:1, pts:[0,0,1, 40,40,1], bb:[-1,-1,41,41] }] : [];
      v._bb = null;
      C.__reset();
      try { v.bake(); v.drawLive(); }
      catch (e) { ok(false, `bake/drawLive 가 던짐 grid=${g} 획=${withStrokes}: ${e.message}`); continue; }
      const n = Object.values(C.__calls).reduce((a, b) => a + b, 0);
      ok(n > 0, `grid=${g} 획=${withStrokes} → 그리기 호출 ${n}건`);
    }
  }

  // ── 패턴이 재사용되나 ── 뷰가 안 바뀌면 타일을 다시 안 만든다
  v.doc.strokes = []; v._bb = null; v.grid = 'dot'; v._pats.clear();
  C.__reset(); v.bake(); const p1 = C.__calls.createPattern || 0;
  C.__reset(); v.bake(); v.bake(); v.bake(); const p2 = C.__calls.createPattern || 0;
  ok(p1 === 1 && p2 === 0, `타일은 한 번만 만든다 (첫 굽기 ${p1} · 이후 3회 ${p2})`);
  v.setGrid('line');
  C.__reset(); v.bake(); ok((C.__calls.createPattern||0) === 1, '모드를 바꾸면 타일을 다시 만든다');

  // ── 핀치 중 타일을 계속 새로 만들지 않나 ── 줌을 40프레임 흔들어 본다
  v.grid = 'dot'; v._pats.clear(); v.doc.strokes = [];
  C.__reset();
  for (let i = 0; i < 40; i++) { v.doc.view.k = 1 + (i % 8) * 0.05; v.bake(); }
  const made = C.__calls.createPattern || 0;
  v.doc.view.k = 1;
  ok(made <= 8, `줌을 40프레임 흔들어도 타일은 간격 수만큼만 만든다 (${made}건)`);

  // ── 격자 비용이 화면 크기와 무관한가 ──
  v.grid = 'dot'; v.bake();
  C.__reset(); v.bake(); const nSmall = Object.values(C.__calls).reduce((a,b)=>a+b,0);
  v.wrap.getBoundingClientRect = () => ({left:0,top:0,right:4000,bottom:3000,width:4000,height:3000});
  C.__reset(); v.bake(); const nBig = Object.values(C.__calls).reduce((a,b)=>a+b,0);
  ok(nBig === nSmall, `격자 비용이 화면 크기에 안 비례한다 (800x600 ${nSmall} · 4000x3000 ${nBig})`);
  v.wrap.getBoundingClientRect = () => ({left:0,top:0,right:800,bottom:600,width:800,height:600});

  // ── 격자를 끄면 격자 몫이 빠지나 ──
  v.doc.strokes = []; v._bb = null;
  v.grid = 'off'; C.__reset(); v.bake(); const nOff = (C.__calls.stroke||0)+(C.__calls.fill||0);
  v.grid = 'dot'; C.__reset(); v.bake(); const nDot = (C.__calls.stroke||0)+(C.__calls.fill||0);
  ok(nDot > nOff, `격자 켜면 그리기가 는다 (off ${nOff} → dot ${nDot})`);

  // ── 미니맵 ──
  v.map = false; C.__reset(); v.drawLive(); const mOff = C.__calls.strokeRect || 0;
  v.map = true;  C.__reset(); v.drawLive(); const mOn  = C.__calls.strokeRect || 0;
  ok(mOn > mOff, `미니맵을 켜면 창 사각형이 그려진다 (${mOff} → ${mOn})`);
  v.setMap(false); ok(p.settings.map === false, '미니맵 설정이 저장된다');

  // ── 내용 사각형 캐시 ──
  v.doc.strokes = [{ c:'#000', w:2, a:1, pts:[10,10,1, 20,20,1], bb:[9,9,21,21] }];
  v._bb = null;
  const bb1 = v.contentBB();
  ok(bb1 && bb1[0] === 9 && bb1[2] === 21, '내용 사각형이 맞다');
  ok(v.contentBB() === bb1, '두 번째 호출은 캐시를 쓴다');
  v.cur = { c:'#000', w:2, a:1, pts:[100,100,1, 110,110,1] }; v.commitStroke();
  ok(v.contentBB()[2] >= 110, '획을 더하면 캐시가 버려지고 다시 잰다');

  // ── touchType 을 안 주는 하드웨어에서 Pointer 경로가 살아 있나 ──
  const T = (type, x, y) => ({ identifier: 1, touchType: type, clientX: x, clientY: y, force: 0.5 });
  const ev = (chg, all) => ({ changedTouches: chg, touches: all, preventDefault(){} });

  v.useTouch = false; v.cur = null; v.doc.strokes = [];
  v.onTouch(ev([T(undefined, 10, 10)], [T(undefined, 10, 10)]), 'start');   // 안드로이드/윈도우 펜
  ok(v.useTouch === false, 'touchType 이 없으면 Touch 경로를 안 켠다');
  v.onDown({ pointerType:'pen', button:0, buttons:1, clientX:10, clientY:10, pressure:0.5, preventDefault(){} });
  ok(v.cur !== null, '그 경우 Pointer 경로가 펜을 받아 획을 시작한다');

  v.cur = null; v.useTouch = false;
  v.onTouch(ev([T('stylus', 10, 10)], [T('stylus', 10, 10)]), 'start');     // 애플 펜슬
  ok(v.useTouch === true, 'stylus 를 보면 Touch 경로를 켠다');
  ok(v.cur !== null, '그 자리에서 획이 시작된다');
  v.onDown({ pointerType:'pen', button:0, buttons:1, clientX:99, clientY:99, pressure:0.5, preventDefault(){} });
  ok(v.cur.pts[0] === 10, 'Touch 경로가 켜지면 Pointer 쪽 펜은 무시된다');
  v.cur = null; v.useTouch = false;

  console.log(fail.length ? `\n✗ 실패 ${fail.length}건` : '\n○ 전부 통과');
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('터짐:', e); process.exit(2); });
