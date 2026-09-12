class Notice { constructor(m){ Notice.last = m; } }
class Plugin {
  constructor(){ this.views={}; this._data=null;
    this.app = { workspace: { on(){ return {}; }, getActiveFile(){ return null; },
                              getLeaf(){ return { openFile: async()=>{} }; } },
                 vault: { getAbstractFileByPath(){ return null; }, create: async()=>({}) } }; }
  registerView(t,f){ this.views[t]=f; }
  registerExtensions(){} addRibbonIcon(){} addCommand(){} registerEvent(){}
  async loadData(){ return this._data; }
  async saveData(d){ this._data = JSON.parse(JSON.stringify(d)); }
}
class TextFileView {
  constructor(){ this.saves = 0; this.contentEl = mkEl('div'); }
  requestSave(){ this.saves++; }
}
class ItemView {}
class Menu {}
function mkEl(tag){
  const e = {
    tag, children: [], classes: new Set(), style: {}, dataset: {}, _text: '',
    createDiv(o={}){ return this._add(mkEl('div'), o); },
    createSpan(o={}){ return this._add(mkEl('span'), o); },
    createEl(t,o={}){ return this._add(mkEl(t), o); },
    _add(c,o){ if(o.cls) String(o.cls).split(' ').forEach(x=>c.classes.add(x));
               if(o.text!=null) c._text=o.text; if(o.type) c.type=o.type;
               this.children.push(c); return c; },
    addClass(c){ this.classes.add(c); },
    empty(){ this.children.length = 0; },
    querySelectorAll(){ return []; },
    appendChild(c){ this.children.push(c); return c; },
    toggleClass(c,on){ on ? this.classes.add(c) : this.classes.delete(c); },
    setText(s){ this._text = s; },
    getBoundingClientRect(){ return {left:0,top:0,right:800,bottom:600,width:800,height:600}; },
    addEventListener(){}, removeEventListener(){},
    getContext(){ return CTX; },
  };
  return e;
}
// 캔버스 2D 스텁. 호출을 세어 두면 「격자를 정말 그렸나」를 볼 수 있다.
const CALLS = {};
const METHODS = /^(save|restore|beginPath|closePath|moveTo|lineTo|quadraticCurveTo|arcTo|stroke|fill|arc|clearRect|fillRect|strokeRect|setTransform|translate|scale|setLineDash)$/;
const CTX = new Proxy({}, {
  get: (t, k) => {
    if (k in t) return t[k];
    if (typeof k === 'string' && METHODS.test(k))
      return (t[k] = (...a) => { CALLS[k] = (CALLS[k] || 0) + 1; });
    return undefined;
  },
  set: (t, k, v) => { t[k] = v; return true; },
});
CTX.__calls = CALLS;
CTX.__reset = () => { for (const k of Object.keys(CALLS)) delete CALLS[k]; };
// 캔버스는 CSS var() 를 못 받으므로 플러그인이 getComputedStyle 로 푼다
global.getComputedStyle = () => ({ getPropertyValue: () => '#808080' });

// 격자 타일이 offscreen 캔버스를 만든다
global.document = global.document || {
  createElement: (tag) => {
    const c = mkEl(tag);
    c.getContext = () => TILE;
    return c;
  },
};
const TILE = new Proxy({}, {
  get: (t, k) => (k in t ? t[k]
    : typeof k === 'string' && METHODS.test(k) ? (t[k] = () => {}) : undefined),
  set: (t, k, v) => { t[k] = v; return true; },
});
CTX.createPattern = (c, rep) => { CALLS.createPattern = (CALLS.createPattern||0)+1; return { __pat: rep }; };

module.exports = { Notice, Plugin, TextFileView, ItemView, Menu, __mkEl: mkEl, __ctx: CTX };
