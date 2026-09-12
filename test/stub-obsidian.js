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
const CTX = new Proxy({}, { get:(t,k)=> k in t ? t[k] : (t[k] = (typeof k==='string' && /^(save|restore|beginPath|moveTo|lineTo|quadraticCurveTo|stroke|fill|arc|clearRect|fillRect|setTransform|translate|scale)$/.test(k)) ? ()=>{} : undefined), set:(t,k,v)=>{t[k]=v;return true;} });
module.exports = { Notice, Plugin, TextFileView, ItemView, Menu, __mkEl: mkEl };
