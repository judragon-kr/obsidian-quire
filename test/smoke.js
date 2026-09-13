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

const TAP_MS_TEST = 320;   // main.js 의 TAP_MS 와 같아야 한다
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

  // ── H. v2 · 이미지 · 올가미 · 방사형 메뉴 ──────────────────
  v.radial = null; v.drag = null; v.lasso = null;

  // v1 파일에 images 가 없어도 열려야 한다. 버전으로 거르면 옛 파일이 다 죽는다.
  v.setViewData(JSON.stringify({ v: 1, strokes: [{ c:'#000', w:2, a:1, pts:[0,0,1, 10,10,1] }] }));
  ok(v.doc.strokes.length === 1, 'v1 파일이 그대로 열린다');
  ok(Array.isArray(v.doc.images) && v.doc.images.length === 0, 'images 가 빈 배열로 채워진다');
  ok(v.readonly === false, 'v1 이라고 readonly 로 안 잠근다');
  ok(Array.isArray(JSON.parse(v.getViewData()).images), '저장할 때도 images 가 나간다');

  v.setViewData('');
  v.placeImage('att/a.png', 400, 300);
  ok(v.doc.images.length === 1, '이미지가 문서에 들어간다');
  const im0 = v.doc.images[0];
  ok(im0.w <= 400 && im0.h <= 300, '화면 절반을 안 넘게 줄인다');
  ok(Math.abs(im0.w / im0.h - 4 / 3) < 0.01, '가로세로비가 유지된다');
  v.undo(); ok(v.doc.images.length === 0, 'undo 가 이미지도 되돌린다');
  v.redo(); ok(v.doc.images.length === 1, 'redo 도 이미지를 되살린다');

  // 올가미 — 완전히 안에 든 것만. 걸친 것은 안 잡힌다.
  v.setViewData('');
  v.doc.strokes = [
    { c:'#000', w:2, a:1, pts:[10,10,1, 20,20,1], bb:[6,6,24,24] },    // 안
    { c:'#000', w:2, a:1, pts:[10,10,1, 90,90,1], bb:[6,6,94,94] },    // 걸침
    { c:'#000', w:2, a:1, pts:[80,80,1, 90,90,1], bb:[76,76,94,94] },  // 밖
  ];
  v.lasso = [0,0, 50,0, 50,50, 0,50];
  v.selectByLasso();
  ok(v.sel.s.size === 1 && v.sel.s.has(0), '완전히 안에 든 획만 골라진다');
  ok(v.lasso === null, '고르고 나면 올가미 자취는 지워진다');

  // 이동 — 이력이 같이 움직이면 안 된다 (얕은 복사 함정)
  v.setViewData('');
  v.doc.strokes = [{ c:'#000', w:2, a:1, pts:[10,10,1, 20,20,1], bb:[6,6,24,24] }];
  v.sel.s.add(0);
  v.drag = { ox:0, oy:0, dx:100, dy:50 };
  v.dropDrag();
  ok(v.doc.strokes[0].pts[0] === 110, '획이 실제로 옮겨진다');
  ok(v.doc.strokes[0].bb[0] > 100, 'bb 가 다시 계산된다');
  v.undo();
  ok(v.doc.strokes[0].pts[0] === 10, 'undo 가 이동 전 좌표를 돌려준다');

  v.setViewData('');
  v.doc.strokes = [{ c:'#000', w:2, a:1, pts:[10,10,1], bb:[6,6,14,14] }];
  v.doc.images = [{ id:'x', src:'a.png', x:0, y:0, w:10, h:10 }];
  v.sel.s.add(0); v.sel.i.add(0);
  v.deleteSel();
  ok(v.doc.strokes.length === 0 && v.doc.images.length === 0, 'Delete 가 획과 이미지를 지운다');
  ok(v.hasSel === false, '지운 뒤 선택이 비워진다');
  v.undo();
  ok(v.doc.strokes.length + v.doc.images.length === 2, 'undo 가 둘 다 되살린다');
  ok(v.hasSel === false, '되돌린 뒤에도 선택은 안 살아난다 — 없어진 획을 가리키면 안 된다');

  // 방사형 메뉴 — 가운데는 취소, 안 고리는 도구, 바깥 고리는 색·굵기
  v.setViewData('');
  v.openRadial(200, 200);
  ok(v.radial !== null, '메뉴가 열린다');
  ok(v.radialHit(200, 200) === null, '가운데는 아무것도 아니다');
  ok(v.radialHit(200, 400) === null, '너무 바깥은 취소다');
  const hIn = v.radialHit(200, 150), hOut = v.radialHit(200, 105);
  ok(hIn && hIn.k === 'tool', '안 고리는 도구다');
  ok(hOut && (hOut.k === 'color' || hOut.k === 'width'), '바깥 고리는 색이나 굵기다');
  v.radial.hit = { k:'width', v:7 };
  v.closeRadial(true);
  ok(v.width === 7 && v.radial === null, '떼면 고른 것이 적용되고 메뉴가 닫힌다');
  v.openRadial(100, 100);
  v.radial.hit = { k:'width', v:1.2 };
  v.closeRadial(false);
  ok(v.width === 7, '취소하면 적용 안 된다');

  // 지우개로 누른 채 메뉴가 뜨면 erasing 이 남아 그 뒤로 획이 계속 지워진다
  v.setViewData('');
  v.setTool('er');
  v.beginPen(5, 5, 1, 5, 5);
  ok(v.erasing === true, '지우개는 누르는 순간 켜진다');
  v.openRadial(60, 60);
  ok(v.erasing === false, '메뉴가 뜨면 지우개가 꺼진다');
  v.closeRadial(false);
  v.setTool('pen');

  // 메뉴가 열리면 그리던 획은 버린다. 안 버리면 여는 동작이 점 하나로 남는다.
  v.cur = { c:'#000', w:2, a:1, pts:[1,1,1] };
  v.openRadial(50, 50);
  ok(v.cur === null, '메뉴가 열리면 그리던 획이 버려진다');
  v.closeRadial(false);

  // sel 도구에서는 자가 복구가 획을 만들면 안 된다
  v.setTool('sel'); v.cur = null; v.useTouch = false;
  v.onMove({ pointerType:'pen', buttons:1, clientX:40, clientY:40,
             preventDefault(){}, getCoalescedEvents(){ return []; } });
  ok(v.cur === null, 'sel 도구에서 자가 복구가 획을 안 만든다');
  v.setTool('pen'); v.lasso = null; v.drag = null;

  // ── I. 꾹 누르기 · 손가락 톡 ────────────────────────────
  v.setViewData(''); v.setTool('pen'); v.cur=null; v.radial=null; v.tap=null;

  // 펜만으로는 안 열려야 한다 — 점 찍으려고 굴리면 메뉴가 뜨던 자리
  v.beginPen(0, 0, 1, 100, 100);
  v.movePen(0, 0, 104, 103);                       // 점 찍을 때의 미세한 굴림
  ok(v.radial === null, '펜을 대고 굴려도 메뉴가 안 뜬다');
  ok(v.cur !== null, '그 대신 획이 그어진다');
  v.cur = null;

  // 손가락 톡 — 뗄 때 열린다. 얹어 둔 손바닥은 안 걸린다
  v.radial=null; v.tap=null;
  v.penPos = [200, 150];
  v.fingerTapDown({ identifier: 7, clientX: 50, clientY: 50 });
  ok(v.tap !== null, '손가락이 닿으면 톡 후보로 잡는다');
  ok(v.radial === null, '닿는 순간에는 안 연다');
  ok(v.fingerTapUp({ identifier: 7, clientX: 52, clientY: 51 }) === true, '짧게 떼면 연다');
  ok(v.radial !== null && v.radial.cx === 200, '메뉴가 펜 자리에 뜬다');

  // 오래 눌린 것(손바닥)은 톡이 아니다
  v.closeRadial(false); v.tap=null;
  v.fingerTapDown({ identifier: 8, clientX: 50, clientY: 50 });
  v.tap.at -= (TAP_MS_TEST + 50);
  ok(v.fingerTapUp({ identifier: 8, clientX: 50, clientY: 50 }) === false, '오래 눌렸으면 톡이 아니다');
  ok(v.radial === null, '그 경우 메뉴가 안 뜬다');

  // 많이 끌린 것도 톡이 아니다
  v.tap=null;
  v.fingerTapDown({ identifier: 9, clientX: 50, clientY: 50 });
  ok(v.fingerTapUp({ identifier: 9, clientX: 90, clientY: 90 }) === false, '끌었으면 톡이 아니다');

  // 펜이 안 닿아 있으면 톡이 무의미하다
  v.tap=null; v.penPos=null;
  v.fingerTapDown({ identifier: 10, clientX: 50, clientY: 50 });
  ok(v.fingerTapUp({ identifier: 10, clientX: 50, clientY: 50 }) === false, '펜이 없으면 안 연다');
  v.radial=null; v.tap=null; v.cur=null;

  console.log(fail.length ? `\n✗ 실패 ${fail.length}건` : '\n○ 전부 통과');
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('터짐:', e); process.exit(2); });
