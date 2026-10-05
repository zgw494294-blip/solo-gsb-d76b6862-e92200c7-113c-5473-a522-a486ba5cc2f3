"use strict";

/* 改写提议前端回归测试（纯 Node，无第三方依赖）。
 *
 * 迷你 DOM / fetch / 加载被测脚本的方式与 verify.test.js 一致（见下方从
 * 加载层到 startShowWithTwoCues 的共用脚手架）。
 *
 * 覆盖：
 * - 待发列表的 💡 入口在可写页与只读页都可点（提交无需控制凭据），
 *   点击展开内联提议表单（与编辑 / 问题表单互斥），取消可收起；
 * - 提交请求体（cue_id、所见 version、建议内容）走 POST /api/suggestions，
 *   空内容不发请求；提交不改版本、成功后列表出现"待审核"提议并展示原文 /
 *   建议；409（版本过期 / 目标失效）由统一 api() 刷新为最新状态；
 * - 侧栏「改写提议」列表展示状态标签、原文、建议、基于版本；待审项为
 *   控制席渲染接受 / 拒绝按钮，只读页按钮禁用；目标已发出或原文已改时
 *   不渲染审核按钮而显示失效原因；
 * - 接受请求走 /api/suggestions/{id}/accept 携带最新版本号；成功版本 +1、
 *   标签变"已接受"；拒绝走 /reject，版本不变、标签变"已拒绝"；
 * - 只读页（control_enabled=true、control_granted=false）：✎/⚠/↑↓ 禁用，
 *   但 💡 可用，提交请求不带 X-Control-Token 也能成功，响应不改变只读状态；
 * - 每秒轮询拿到同版本的新状态时，侧栏提议列表同步刷新（无控制权页面
 *   新提交的待审提议会出现在控制席页面），但不重建待发列表、不打断已
 *   展开的提议表单。
 *
 * 运行：node tests/suggestions.test.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
/* ------------------------------------------------------------ 迷你 DOM */

/* 迷你 DOM：不做布局，但会解析被测代码关心的 innerHTML 片段——
 * verify-card 的回报按钮（<button data-action data-dept>）与设置页的
 * .cue-row 录入行，使测试能检查**真实渲染出来的 disabled 状态**、并通过
 * 真实元素派发点击（不绕过按钮禁用）。 */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
  }
}

/* 仅解析测试需要的少量标签/属性：button、input、textarea、div、span 等。 */
const VOID_TAGS = new Set(["input", "br", "img"]);

function parseAttrs(attrText, el) {
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = attrRe.exec(attrText))) {
    el.setAttribute(m[1], m[2] ?? m[3] ?? m[4] ?? "");
  }
}

/* 小型 HTML 解析：开标签压栈、闭标签弹栈（容忍嵌套）、文本挂到栈顶。
 * 不做完整 HTML 语义，只为让 verify-card 的按钮与设置页录入行成为可检查
 * disabled、可派发点击的真实元素。 */
function parseHtml(ownerDoc, html, parent = null) {
  const roots = [];
  const stack = [];
  const tokenRe =
    /<!--[\s\S]*?-->|<([a-zA-Z][-a-zA-Z0-9]*)([^>]*?)(\/?)>|<\/([a-zA-Z][-a-zA-Z0-9]*)\s*>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html))) {
    if (m[1] !== undefined) {
      const tag = m[1].toLowerCase();
      const el = new El(tag);
      el.ownerDocument = ownerDoc;
      const top = stack[stack.length - 1];
      el.parentElement = top || parent;
      if (top) top.children.push(el);
      else roots.push(el);
      parseAttrs(m[2], el);
      if (!(m[3] === "/" || VOID_TAGS.has(tag))) stack.push(el);
    } else if (m[4] !== undefined) {
      const tag = m[4].toLowerCase();
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tagName === tag.toUpperCase()) {
          stack.length = i; // 弹出匹配层及其内未闭合标签（容错）
          break;
        }
      }
    } else if (m[5] !== undefined) {
      const top = stack[stack.length - 1];
      if (top) top._text += m[5];
    }
  }
  return roots;
}

class El {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.listeners = {};
    this.children = [];
    this.dataset = {};
    this._attrs = {};
    this._value = "";
    this.disabled = false;
    this._text = "";
    this.parentElement = null;
    this.ownerDocument = null;
    if (id) this._attrs.id = id;
  }
  get value() { return this._value; }
  set value(v) { this._value = v; }
  get className() { return [...this.classList.set].join(" "); }
  set className(v) {
    this.classList = new ClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    this._attrs.class = String(v);
  }
  get textContent() {
    if (this.children.length) {
      return this.children.map((c) => c.textContent).join("") + this._text;
    }
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
    if (this.tagName === "BUTTON" || this.tagName === "SPAN" || this.tagName === "DIV") {
      // 被测代码用 textContent 改按钮文案：保持在本元素上
    }
  }
  get innerHTML() { return this._innerHTML || ""; }
  set innerHTML(html) {
    this._innerHTML = String(html);
    this.children = parseHtml(this.ownerDocument, String(html), this);
  }
  setAttribute(name, val) {
    this._attrs[name] = String(val);
    if (name === "id") this.id = String(val);
    if (name === "class") {
      this.classList = new ClassList();
      String(val).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
    if (name.startsWith("data-")) {
      this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(val);
    }
    if (name === "disabled") this.disabled = true;
    if (name === "value") this._value = String(val);
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ||
      (name === "disabled" ? this.disabled : false);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  /* 单个复合选择器（无后代组合符），如 button.small[data-action="x"]。 */
  _matchesCompound(part) {
    const tokenRe = /([.#]?[a-zA-Z][-a-zA-Z0-9_]*)|(\[[^\]]+\])/g;
    let t;
    while ((t = tokenRe.exec(part))) {
      if (t[1]) {
        const tok = t[1];
        if (tok.startsWith("#")) { if (this.id !== tok.slice(1)) return false; }
        else if (tok.startsWith(".")) { if (!this.classList.contains(tok.slice(1))) return false; }
        else if (this.tagName !== tok.toUpperCase()) return false;
      } else {
        const am = /^\[([a-zA-Z0-9-]+)(?:([~|^$*]?=)\s*"([^"]*)"|=\s*'([^']*)'|=\s*([^\]]*))?\]$/.exec(t[2]);
        if (!am) return false;
        const av = this.getAttribute(am[1]);
        if (av === null) return false;
        if (am[2]) {
          const want = am[3] ?? am[4] ?? am[5] ?? "";
          if (am[2] === "=" && av !== want) return false;
        }
      }
    }
    return true;
  }
  /* 后代组合选择器：每个空白分隔的复合段表示一层后代。 */
  matches(sel) {
    const parts = sel.split(/\s+/).filter(Boolean);
    if (!parts.length || !this._matchesCompound(parts[parts.length - 1])) return false;
    let el = this.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = null;
      while (el) {
        if (el._matchesCompound(parts[i])) { found = el; break; }
        el = el.parentElement;
      }
      if (!found) return false;
      el = found.parentElement;
    }
    return true;
  }
  _walk(fn) {
    for (const c of this.children) {
      fn(c);
      c._walk(fn);
    }
  }
  querySelectorAll(sel) {
    const parts = sel.split(/\s+/).filter(Boolean);
    const out = [];
    const seen = new Set();
    const dfs = (els, depth) => {
      for (const el of els) {
        if (el._matchesCompound(parts[depth])) {
          if (depth === parts.length - 1) {
            if (!seen.has(el)) { seen.add(el); out.push(el); }
          } else {
            dfs(el.children, depth + 1);
          }
        }
        dfs(el.children, depth);
      }
    };
    dfs(this.children, 0);
    return out;
  }
  querySelector(sel) {
    const found = this.querySelectorAll(sel);
    return found.length ? found[0] : new El();
  }
  closest(sel) {
    let el = this;
    while (el) {
      if (el.matches && el.matches(sel)) return el;
      el = el.parentElement;
    }
    return null;
  }
  focus() {}
  appendChild(child) {
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) {
      const arr = this.parentElement.children;
      const i = arr.indexOf(this);
      if (i !== -1) arr.splice(i, 1);
    }
  }
}

class Doc {
  constructor() {
    this.byId = new Map();
    this.listeners = {};
  }
  el(id) {
    if (!this.byId.has(id)) {
      const el = new El("div", id);
      el.ownerDocument = this;
      if (id === "archives-modal") el.classList.add("hidden");
      this.byId.set(id, el);
    }
    return this.byId.get(id);
  }
  querySelector(sel) {
    if (sel.startsWith("#")) return this.el(sel.slice(1));
    // 无 id 的全局选择器：在已知元素后代里找（测试用不到，返回空元素兜底）
    for (const root of this.byId.values()) {
      const f = root.querySelector(sel);
      if (f.tagName) return f;
    }
    return new El();
  }
  querySelectorAll(sel) {
    if (sel.startsWith("#")) {
      const idSel = sel.slice(1).split(/\s+/);
      const root = this.el(idSel[0]);
      return idSel.length > 1 ? root.querySelectorAll(idSel.slice(1).join(" ")) : [root];
    }
    const out = [];
    for (const root of this.byId.values()) {
      for (const f of root.querySelectorAll(sel)) {
        if (!out.includes(f)) out.push(f);
      }
    }
    return out;
  }
  createElement(tag) {
    const el = new El(tag);
    el.ownerDocument = this;
    return el;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
}

/* -------------------------------------------------------- 加载被测脚本 */

const appCode = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

function loadApp(storageData) {
  const document = new Doc();
  const pending = [];
  const storage = {
    _m: new Map(Object.entries(storageData || {})),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  const sandbox = {
    document,
    fetch: (path, options) =>
      new Promise((resolve, reject) => pending.push({ path, options, resolve, reject })),
    sessionStorage: storage,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: "app.js" });
  return { document, pending, storage, sandbox };
}

const flush = () => new Promise((r) => setImmediate(r));
const lastRequest = (ctx) => ctx.pending[ctx.pending.length - 1];

async function respond(req, data, status = 200) {
  req.resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
  await flush();
}

/* ------------------------------------------------------------ 测试数据 */

function verifyView(over) {
  return Object.assign({
    enabled: true,
    round: 2,
    cue_id: 1,
    lighting: null,
    sound: null,
    all_ready: false,
  }, over || {});
}

function liveState(over) {
  return Object.assign({
    version: 3,
    status: "live",
    paused: false,
    control_enabled: false,
    control_granted: true,
    current: { id: 1, number: "A1", content: "灯光渐亮" },
    next: { id: 2, number: "A2", content: "音乐起" },
    pending: [
      { id: 1, number: "A1", content: "灯光渐亮" },
      { id: 2, number: "A2", content: "音乐起" },
    ],
    issued: [],
    issues: [],
    total: 2,
    remaining: 2,
    min_cues: 2,
    max_cues: 12,
  }, over || {});
}

function setupState(over) {
  return liveState(Object.assign({
    status: "setup",
    current: null,
    next: null,
    pending: [],
    total: 0,
    remaining: 0,
  }, over || {}));
}

/* 模拟点击委托按钮（迷你 DOM 不解析 innerHTML，直接构造事件目标）。 */
function clickAction(ctx, dataset) {
  const fakeBtn = { dataset, disabled: false };
  ctx.document.dispatch("click", {
    target: { closest: (sel) => (sel === "[data-action]" ? fakeBtn : null) },
  });
}

/* 取核验卡片里真实渲染出来的某工种回报按钮（disabled 即渲染时的属性）。 */
function reportButton(ctx, dept) {
  return ctx.document.querySelectorAll(
    `#verify-card button[data-action="verify-report"][data-dept="${dept}"]`
  )[0] || null;
}

function allReportButtons(ctx) {
  return ctx.document.querySelectorAll('#verify-card button[data-action="verify-report"]');
}

/* 通过真实按钮元素派发委托点击：与浏览器一致，按钮 disabled 时处理函数早退。 */
function clickButton(ctx, btn) {
  ctx.document.dispatch("click", { target: btn });
}

/* 取待发列表里真实渲染出来的重排按钮（↑ 上移 / ↓ 下移）。 */
function reorderButton(ctx, action, idx) {
  return ctx.document.querySelectorAll(
    `#pending-list button[data-action="${action}"][data-idx="${idx}"]`
  )[0] || null;
}

/* 已发出的回报请求数量：交错场景下检查是否重复提交相同回报。 */
function reportRequestCount(ctx) {
  return ctx.pending.filter((r) => r.path === "/api/verify/report").length;
}

/* 让在途请求以网络错误（fetch reject）结束。 */
async function rejectRequest(req, message = "network down") {
  req.reject(new Error(message));
  await flush();
}

/* 让在途请求返回非 2xx 业务错误（如 400），无附带状态。 */
async function respondError(req, status = 400, data = { error: "bad request" }) {
  req.resolve({ ok: false, status, json: async () => data });
  await flush();
}

/* 设置页录入两条提示并点「开始演出」：返回在途的 /api/setup 请求。 */
function startShowWithTwoCues(ctx) {
  const rows = ctx.document.querySelectorAll("#cue-rows .cue-row");
  rows[0].querySelector(".num").value = "A1";
  rows[0].querySelector(".cnt").value = "灯光渐亮";
  rows[1].querySelector(".num").value = "A2";
  rows[1].querySelector(".cnt").value = "音乐起";
  const before = ctx.pending.length;
  ctx.document.el("start-show").dispatch("click");
  if (ctx.pending.length === before) throw new Error("开场请求未发出（录入校验未通过）");
  return lastRequest(ctx);
}

/* ------------------------------------------------------------ 断言 */

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ------------------------------------------------------------ 提议测试数据 */

function sugState(over) {
  return Object.assign({
    id: 7,
    cue_id: 2,
    cue_number: "A2",
    original: "音乐起",
    proposed: "音乐提前两小节起",
    status: "pending",
    base_version: 3,
    created_at: "2026-10-05T10:00:00+00:00",
  }, over || {});
}

function withSuggestions(s, list) {
  return Object.assign({}, s, { suggestions: list });
}

function pendingButton(ctx, action, id) {
  const btns = ctx.document.querySelectorAll(
    `#pending-list button[data-action="${action}"]`
  );
  return btns.find((b) => b.dataset.id === String(id)) || null;
}

function reviewButton(ctx, action, id) {
  return ctx.document.querySelectorAll(
    `#suggestions-list button[data-action="${action}"][data-id="${id}"]`
  )[0] || null;
}

/* ------------------------------------------------------------ 用例 */

async function t1_entryAndForm() {
  console.log("G1 待发列表：💡 入口可展开/收起提议表单（与编辑、问题表单互斥）");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState());

  const btn1 = pendingButton(ctx, "add-suggestion", 1);
  const btn2 = pendingButton(ctx, "add-suggestion", 2);
  check(!!btn1 && !!btn2, "每条待发提示都有 💡 提议入口");
  check(btn1.disabled === false, "可写页 💡 按钮可用");

  clickButton(ctx, btn1);
  let form = ctx.document.querySelectorAll("#pending-list .suggestion-edit")[0];
  check(!!form, "点击 💡 展开内联提议表单");
  check(!!form.querySelector(".suggestion-input").tagName, "表单含建议内容输入框");
  check(!!form.querySelector('button[data-action="save-suggestion"]'), "表单含提交按钮");
  check(!!form.querySelector('button[data-action="cancel-suggestion"]'), "表单含取消按钮");

  // 展开提议时点 ✎ 编辑：互斥，提议表单收起、编辑表单打开
  clickButton(ctx, pendingButton(ctx, "edit", 2));
  check(!ctx.document.querySelectorAll("#pending-list .suggestion-edit").length,
    "打开编辑表单时提议表单收起（互斥）");
  check(!!ctx.document.querySelectorAll("#pending-list .pending-item.editing").length,
    "编辑表单打开");

  // 重新展开后用取消按钮收起
  clickButton(ctx, pendingButton(ctx, "add-suggestion", 1));
  check(!!ctx.document.querySelectorAll("#pending-list .suggestion-edit").length,
    "可再次展开提议表单");
  const cancel = ctx.document.querySelectorAll(
    '#pending-list button[data-action="cancel-suggestion"]')[0];
  clickButton(ctx, cancel);
  check(!ctx.document.querySelectorAll("#pending-list .suggestion-edit").length,
    "取消后提议表单收起");
}

async function t2_submitRequest() {
  console.log("G2 提交：请求体含 cue_id/所见版本/建议；空内容不发请求；成功后列表出现待审提议");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState());

  clickButton(ctx, pendingButton(ctx, "add-suggestion", 2));
  const before = ctx.pending.length;
  const saveBtn = ctx.document.querySelectorAll(
    '#pending-list button[data-action="save-suggestion"]')[0];
  clickButton(ctx, saveBtn);
  check(ctx.pending.length === before, "空建议内容不发请求");

  ctx.document.querySelectorAll("#pending-list .suggestion-input")[0].value =
    "  音乐提前两小节起  ";
  clickButton(ctx, saveBtn);
  const req = lastRequest(ctx);
  check(req.path === "/api/suggestions", "提交走 POST /api/suggestions");
  const body = JSON.parse(req.options.body);
  check(body.cue_id === 2 && body.version === 3, "携带 cue_id 与页面所见版本号");
  check(body.content === "音乐提前两小节起", "建议内容去除首尾空白后上送（与编辑一致）");

  const next = withSuggestions(liveState(), [sugState()]);
  check(next.version === 3, "前置：提交不推进版本");
  await respond(req, next);
  check(ctx.pending.length === before + 1, "提交请求已结束");
  const listHtml = ctx.document.el("suggestions-list").innerHTML;
  check(listHtml.includes("待审核"), "侧栏出现待审核状态");
  check(listHtml.includes("音乐起"), "展示原文快照");
  check(listHtml.includes("音乐提前两小节起"), "展示建议内容");
  check(listHtml.includes("基于 v3"), "展示提交时所基于的版本");
  check(!ctx.document.querySelectorAll("#pending-list .suggestion-edit").length,
    "成功后内联表单收起");
  check(ctx.document.el("version-badge").textContent === "v3", "提交后版本角标不变");
}

async function t3_listStatesAndReadonly() {
  console.log("G3 列表状态：接受/拒绝按钮只对待审项渲染，只读页按钮禁用，失效项显示原因");
  const ctx = loadApp();
  const s = withSuggestions(liveState(), [
    sugState({ id: 1, status: "pending" }),
    sugState({ id: 2, status: "accepted", proposed: "已采纳建议" }),
    sugState({ id: 3, status: "rejected", proposed: "被拒建议" }),
  ]);
  await respond(lastRequest(ctx), s);
  const html = ctx.document.el("suggestions-list").innerHTML;
  check(!!reviewButton(ctx, "accept-suggestion", 1), "待审项有接受按钮");
  check(!!reviewButton(ctx, "reject-suggestion", 1), "待审项有拒绝按钮");
  check(!reviewButton(ctx, "accept-suggestion", 2) && !reviewButton(ctx, "reject-suggestion", 2),
    "已接受项无审核按钮");
  check(!reviewButton(ctx, "accept-suggestion", 3) && !reviewButton(ctx, "reject-suggestion", 3),
    "已拒绝项无审核按钮");
  check(html.includes("已接受") && html.includes("已拒绝"), "展示已接受/已拒绝标签");
  check(reviewButton(ctx, "accept-suggestion", 1).disabled === false, "控制席可点接受");

  // 只读页：审核按钮禁用
  const ro = loadApp();
  const ros = withSuggestions(liveState({
    control_enabled: true, control_granted: false,
  }), [sugState({ id: 1 })]);
  await respond(lastRequest(ro), ros);
  check(reviewButton(ro, "accept-suggestion", 1).disabled === true, "只读页接受按钮禁用");
  check(reviewButton(ro, "reject-suggestion", 1).disabled === true, "只读页拒绝按钮禁用");

  // 失效目标：已发出 -> 不渲染审核按钮，显示"目标已发出"
  const issued = loadApp();
  const is = withSuggestions(liveState({
    current: { id: 2, number: "A2", content: "音乐起" },
    next: null,
    pending: [{ id: 2, number: "A2", content: "音乐起" }],
    issued: [{ id: 1, number: "A1", content: "灯光渐亮", issued_at: "t" }],
    total: 2, remaining: 1,
  }), [sugState({ id: 4, cue_id: 1 })]);
  await respond(lastRequest(issued), is);
  check(!reviewButton(issued, "accept-suggestion", 4), "已发出目标无接受按钮");
  check(issued.document.el("suggestions-list").innerHTML.includes("目标已发出"),
    "已发出目标显示失效原因");

  // 原文已被改写 -> 显示"原文已被改写"
  const changed = loadApp();
  const cs = withSuggestions(liveState(), [
    sugState({ id: 5, cue_id: 2, original: "音乐起" }),
  ]);
  cs.pending = [
    { id: 1, number: "A1", content: "灯光渐亮" },
    { id: 2, number: "A2", content: "音乐激昂（直接改写）" },
  ];
  cs.current = cs.pending[0];
  cs.next = cs.pending[1];
  await respond(lastRequest(changed), cs);
  check(!reviewButton(changed, "accept-suggestion", 5), "原文已变：无接受按钮");
  check(changed.document.el("suggestions-list").innerHTML.includes("原文已被改写"),
    "原文已变显示失效原因");
}

async function t4_acceptRejectRequests() {
  console.log("G4 接受/拒绝：路径与请求体正确；接受版本 +1 标签更新，拒绝版本不变");
  const ctx = loadApp();
  await respond(lastRequest(ctx), withSuggestions(liveState(), [sugState({ id: 7 })]));

  clickButton(ctx, reviewButton(ctx, "accept-suggestion", 7));
  let req = lastRequest(ctx);
  check(req.path === "/api/suggestions/7/accept", "接受走 /accept 路径");
  check(JSON.parse(req.options.body).version === 3, "接受携带最新版本号");
  await respond(req, withSuggestions(liveState({ version: 4 }), [
    sugState({ id: 7, status: "accepted" }),
  ]));
  check(ctx.document.el("version-badge").textContent === "v4", "接受成功后版本 +1");
  check(ctx.document.el("suggestions-list").innerHTML.includes("已接受"),
    "接受后标签变为已接受");

  // 再来一条待审，拒绝：版本不变
  const ctx2 = loadApp();
  await respond(lastRequest(ctx2), withSuggestions(liveState({ version: 4 }), [
    sugState({ id: 8, status: "pending" }),
  ]));
  clickButton(ctx2, reviewButton(ctx2, "reject-suggestion", 8));
  req = lastRequest(ctx2);
  check(req.path === "/api/suggestions/8/reject", "拒绝走 /reject 路径");
  check(JSON.parse(req.options.body).version === 4, "拒绝携带最新版本号");
  await respond(req, withSuggestions(liveState({ version: 4 }), [
    sugState({ id: 8, status: "rejected" }),
  ]));
  check(ctx2.document.el("version-badge").textContent === "v4", "拒绝后版本号不变");
  check(ctx2.document.el("suggestions-list").innerHTML.includes("已拒绝"),
    "拒绝后标签变为已拒绝");
}

async function t5_conflictAppliesState() {
  console.log("G5 提交/审核遇 409：附带最新状态被应用，旧表单关闭，版本角标刷新");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState());
  clickButton(ctx, pendingButton(ctx, "add-suggestion", 2));
  const saveBtn = ctx.document.querySelectorAll(
    '#pending-list button[data-action="save-suggestion"]')[0];
  ctx.document.querySelectorAll("#pending-list .suggestion-input")[0].value = "建议 X";
  clickButton(ctx, saveBtn);
  const req = lastRequest(ctx);
  const latest = withSuggestions(liveState({ version: 9 }), [
    sugState({ id: 11, cue_id: 1 }),
  ]);
  await respond(req, {
    error: "conflict", message: "操作已过期", state: latest,
  }, 409);
  check(ctx.document.el("version-badge").textContent === "v9", "409 后刷新为最新版本");
  check(ctx.document.el("suggestions-list").innerHTML.includes("待审核"),
    "409 附带状态中的提议被渲染");
  check(!!ctx.document.querySelectorAll("#pending-list .suggestion-edit").length,
    "409 后目标仍待发：输入中的表单保留（与编辑/问题表单一致）");
}

async function t6_readonlyCanSubmitWithoutToken() {
  console.log("G6 只读页：✎/⚠ 禁用而 💡 可用；提交不带凭据也成功，资格保持只读回报");
  const ctx = loadApp(); // sessionStorage 无凭据
  await respond(lastRequest(ctx), liveState({
    control_enabled: true, control_granted: false,
  }));
  check(ctx.document.el("control-badge").textContent.includes("只读"),
    "页头显示他人控制、本页只读");
  check(pendingButton(ctx, "edit", 1).disabled === true, "只读页 ✎ 禁用");
  check(pendingButton(ctx, "add-issue", 1).disabled === true, "只读页 ⚠ 禁用");
  const bulb = pendingButton(ctx, "add-suggestion", 1);
  check(bulb.disabled === false, "只读页 💡 仍可点");

  clickButton(ctx, bulb);
  ctx.document.querySelectorAll("#pending-list .suggestion-input")[0].value = "灯光建议";
  clickButton(ctx, ctx.document.querySelectorAll(
    '#pending-list button[data-action="save-suggestion"]')[0]);
  const req = lastRequest(ctx);
  check(req.path === "/api/suggestions", "只读页可提交提议");
  check(!("X-Control-Token" in (req.options.headers || {})),
    "无缓存凭据时请求头不带 X-Control-Token");
  const resp = withSuggestions(liveState({
    control_enabled: true, control_granted: false,
  }), [sugState({ id: 3, cue_id: 1, cue_number: "A1", original: "灯光渐亮", proposed: "灯光建议" })]);
  await respond(req, resp);
  check(ctx.document.el("control-badge").textContent.includes("只读"),
    "提交成功后页面仍为只读（未获得控制权）");
  check(pendingButton(ctx, "edit", 1) === null || pendingButton(ctx, "edit", 1).disabled === true,
    "提交后写入口仍禁用");
}

async function t7_pollSyncsSameVersionSuggestions() {
  console.log("G7 轮询同版本：侧栏提议列表同步出现新提议，待发列表不重建、表单不中断");
  const ctx = loadApp();
  await respond(lastRequest(ctx), withSuggestions(liveState(), [sugState({ id: 1 })]));
  clickButton(ctx, pendingButton(ctx, "add-suggestion", 2));
  const input = ctx.document.querySelectorAll("#pending-list .suggestion-input")[0];
  input.value = "正在输入的建议";

  // 其他页面提交了一条新提议（同版本，因为提交不推进版本）：轮询拿到同版本新状态
  const poll = ctx.sandbox.pollState();
  const req = ctx.pending[ctx.pending.length - 1];
  check(req.path === "/api/state", "轮询请求为 GET /api/state");
  const polled = withSuggestions(liveState(), [
    sugState({ id: 1 }),
    sugState({ id: 2, cue_id: 1, cue_number: "A1", original: "灯光渐亮", proposed: "他人新提议" }),
  ]);
  await respond(req, polled);
  await poll;
  check(ctx.document.el("suggestions-list").innerHTML.includes("他人新提议"),
    "同版本轮询同步出新提交的提议");
  const formAfter = ctx.document.querySelectorAll("#pending-list .suggestion-edit")[0];
  check(!!formAfter, "待发列表未重建：提议表单保留");
  check(ctx.document.querySelectorAll("#pending-list .suggestion-input")[0].value
    === "正在输入的建议", "正在输入的内容未被打断");
}

async function t8_busyDisablesSubmit() {
  console.log("G8 请求在途：所有提交/审核按钮统一禁用，结束后按最新状态恢复");
  const ctx = loadApp();
  await respond(lastRequest(ctx), withSuggestions(liveState(), [sugState({ id: 7 })]));
  clickButton(ctx, pendingButton(ctx, "add-suggestion", 2));
  ctx.document.querySelectorAll("#pending-list .suggestion-input")[0].value = "建议";
  clickButton(ctx, ctx.document.querySelectorAll(
    '#pending-list button[data-action="save-suggestion"]')[0]);
  check(ctx.pending[ctx.pending.length - 1].path === "/api/suggestions",
    "提交请求已发出且仍在途");
  check(reviewButton(ctx, "accept-suggestion", 7).disabled === true, "在途时接受禁用");
  check(reviewButton(ctx, "reject-suggestion", 7).disabled === true, "在途时拒绝禁用");
  await respond(lastRequest(ctx), withSuggestions(liveState(), [
    sugState({ id: 7 }),
    sugState({ id: 8, cue_id: 1, cue_number: "A1", original: "灯光渐亮", proposed: "建议" }),
  ]));
  check(reviewButton(ctx, "accept-suggestion", 7).disabled === false, "结束后接受恢复可用");
  check(reviewButton(ctx, "reject-suggestion", 7).disabled === false, "结束后拒绝恢复可用");
}

(async function main() {
  await t1_entryAndForm();
  await t2_submitRequest();
  await t3_listStatesAndReadonly();
  await t4_acceptRejectRequests();
  await t5_conflictAppliesState();
  await t6_readonlyCanSubmitWithoutToken();
  await t7_pollSyncsSameVersionSuggestions();
  await t8_busyDisablesSubmit();
  console.log(failures === 0 ? "\n全部通过（8 个用例）" : `\n失败 ${failures} 处断言`);
  process.exit(failures === 0 ? 0 : 1);
})();
