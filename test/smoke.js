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

  console.log(fail.length ? `\n✗ 실패 ${fail.length}건` : '\n○ 전부 통과');
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('터짐:', e); process.exit(2); });
