/**
 * 按顺序 eval 15 个 CORE min 文件，验证 defer 的执行顺序没有破坏
 * 跨文件的顶层符号依赖（ui.js 顶层 new Maintain / new Storage 这类）。
 *
 * 用"万能 stub"顶住 DOM：任何属性访问都返回一个同样万能的代理，
 * 让脚本的顶层能跑到底。它证明不了运行时行为正确，但能证明
 * "没有 ReferenceError / 顺序没乱"。
 */
const fs = require('fs');
const path = '/data/workspace/gd_live/js/';
const CORE = ['icons','github-api','storage','file-manager','config-sync','task-dock',
              'ui','i18n','version','anim','gesture','custom','theme','i18n-scan','app'];

const defined = new Set();
function makeStub(name) {
  const f = function () { return makeStub(name + '()'); };
  return new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive || k === 'toString') return () => '[stub]';
      if (k === 'then') return undefined;           // 别被当成 thenable
      if (k === Symbol.iterator) return undefined;  // 别被展开
      return makeStub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return makeStub(name + '()'); },
    construct() { return makeStub('new ' + name); },
    has() { return true; },
  });
}

// 记录型 window：赋值要真记下来，才能检查 UI/App 等有没有被定义
const store = {};
const win = new Proxy({}, {
  get(t, k) {
    if (k in store) return store[k];
    if (k === 'Symbol' || k === 'then') return undefined;
    return makeStub('window.' + String(k));
  },
  set(t, k, v) { store[k] = v; defined.add(String(k)); return true; },
  has() { return true; },
});
const doc = makeStub('document');
const nav = makeStub('navigator');
const ls = makeStub('localStorage');

const sandbox = {
  window: win, document: doc, navigator: nav, localStorage: ls,
  location: makeStub('location'), history: makeStub('history'),
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  requestAnimationFrame: () => 0, fetch: () => Promise.resolve(makeStub('res')),
  console, JSON, Math, Date, Promise, Object, Array, String, Number, Boolean,
  Map, Set, Error, RegExp, Symbol, Intl, encodeURIComponent, decodeURIComponent,
  isNaN, parseInt, parseFloat, Blob: makeStub('Blob'), URL: makeStub('URL'),
  Headers: makeStub('Headers'), AbortController: makeStub('AbortController'),
  MutationObserver: makeStub('MutationObserver'),
  IntersectionObserver: makeStub('IntersectionObserver'),
  performance: makeStub('performance'), matchMedia: () => makeStub('mq'),
  CustomEvent: makeStub('CustomEvent'), Event: makeStub('Event'),
  Image: makeStub('Image'), FileReader: makeStub('FileReader'),
  globalThis: null, self: win,
};
sandbox.globalThis = sandbox;
sandbox.self = win;

const vm = require('vm');
vm.createContext(sandbox);

let firstErr = null;
for (const f of CORE) {
  const code = fs.readFileSync(path + f + '.min.js', 'utf8');
  try {
    vm.runInContext(code, sandbox, { filename: f + '.min.js' });
  } catch (e) {
    if (!firstErr) firstErr = f + ': ' + e.message;
  }
}

// ★ 不能用 "w in store" 判断。
//   顶层 const/class 不会挂到 window 上（浏览器里也一样），只有显式写了
//   window.UI = ... 的才会。先按 window.* 找，找不到再回到 context 的
//   词法环境里 typeof —— 同一个 vm context 里多次 runInContext 共享顶层
//   词法绑定，跟浏览器多个 <script> 共享全局词法环境是一样的。
// ★ 符号名要按实际暴露的来，不能想当然。
//   custom/theme/anim/i18n-scan 暴露的是 GdCustom / GdTheme / GdAnim /
//   GdI18nScan（不是 Custom/Theme/Anim）；gesture 完全不暴露全局符号，
//   它只是个副作用模块（注册触摸监听），本来就查不到。
const want = ['UI', 'I18n', 'GitHubAPI', 'Storage', 'FileManager', 'App',
              'TaskDock', 'GdCustom', 'GdTheme', 'GdAnim', 'GdI18nScan', 'Icons'];
const missing = [];
for (const w of want) {
  if (w in store) continue;
  let t = 'undefined';
  try { t = vm.runInContext('typeof ' + w, sandbox); } catch (e) { t = 'ERR'; }
  if (t === 'undefined' || t === 'ERR') missing.push(w + '(' + t + ')');
}
console.log('执行异常:', firstErr || '无');
console.log('window.* 显式挂载:', [...defined].sort().join(', ') || '无');
console.log('缺失的关键符号:', missing.length ? missing.join(', ') : '无');
console.log('RESULT:', (!firstErr && missing.length === 0) ? 'PASS' : 'FAIL');
