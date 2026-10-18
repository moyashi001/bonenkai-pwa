'use strict';

const STATUSES = ['参加', '不参加', '未定'];
const STATUS_CLASS = { 参加: 'yes', 不参加: 'no', 未定: 'maybe' };
const OTHER = '__other__';
const CLASSES = ['1組', '2組'];

const $ = id => document.getElementById(id);
const el = {
  me: $('me-btn'),
  info: $('info'),
  call: $('tab-call'),
  attend: $('tab-attend'),
  memberList: $('member-list'),
  classFilter: $('class-filter'),
  addForm: $('add-form'),
  addClass: $('add-class'),
  bulkClass: $('bulk-class'),
  editClass: $('edit-class'),
  addLast: $('add-last'),
  addFirst: $('add-first'),
  addError: $('add-error'),
  bulkNames: $('bulk-names'),
  bulkError: $('bulk-error'),
  busy: $('busy'),
  busyText: $('busy-text'),
  toast: $('toast'),
};

let state = { members: [], info: [] };
let lastFetched = 0;

// ---- 端末に保存する値（保存できない環境でも動くように try で包む） ----
const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) {
    try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch { /* 保存できなくても動作は続ける */ }
  },
};
let myName = store.get('bonenkai.myName');
let currentTab = store.get('bonenkai.tab') || 'call';
let currentClass = store.get('bonenkai.class') || 'all';
let searchQuery = '';
// 集計タイルでの絞り込み（{ key: 'first' | 'second', status }）
let attendFilter = null;
// 名前を追加したとき「自分として設定するか」を聞くのは1回だけ
let askedMyName = false;

function setMyName(name) {
  myName = name;
  store.set('bonenkai.myName', name);
}

// ---- 名前（「姓 名」の半角スペース区切りで扱う） ----
function joinName(last, first) {
  const strip = s => s.replace(/\s+/g, '');
  return `${strip(last)} ${strip(first)}`.trim();
}

function splitName(name) {
  const i = name.indexOf(' ');
  return i < 0 ? [name, ''] : [name.slice(0, i), name.slice(i + 1)];
}

// 一括追加の1行を「姓 名」にする。名が空なら null
function parseLine(line) {
  const parts = line.trim().split(/\s+/);
  return parts.length >= 2 ? `${parts[0]} ${parts.slice(1).join('')}` : null;
}

function nameError(name, exclude) {
  if (!/^\S+ \S+$/.test(name)) return '姓と名を入力してください';
  if (/^[=+\-@]/.test(name)) return '名前の先頭に記号は使えません';
  if (name !== exclude && state.members.some(m => m.name === name)) {
    return `⚠ 「${name}」はすでに登録されています`;
  }
  return '';
}

// ---- API ----
async function api(action, params = {}) {
  const url = window.GAS_URL;
  if (!url || url.includes('XXXXXXXX')) throw new Error('config.js に GAS の URL を設定してください');
  const res = action === 'list'
    ? await fetch(url)
    // Content-Type を付けない（text/plain になり CORS のプリフライトが発生しない）
    : await fetch(url, { method: 'POST', body: JSON.stringify({ action, ...params }) });
  if (!res.ok) throw new Error(`通信エラー (${res.status})`);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'エラーが発生しました');
  const { result, ...data } = json.data;
  state = data;
  lastFetched = Date.now();
  render();
  return result;
}

// 成功時は { result } を、失敗時は null を返す
async function run(action, params = {}) {
  const loading = action === 'list';
  el.busyText.textContent = loading ? '読み込み中…' : '保存中…';
  el.busy.hidden = false;
  try {
    const result = await api(action, params);
    if (!loading) toast('保存しました', 'success');
    return { result };
  } catch (err) {
    toast(err.message.startsWith('Failed to fetch') ? '通信できませんでした。電波を確認してください' : err.message, 'error');
    return null;
  } finally {
    el.busy.hidden = true;
  }
}

let toastTimer;
function toast(message, type) {
  el.toast.textContent = message;
  el.toast.className = `toast ${type}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, type === 'success' ? 1500 : 5000);
}

// ---- 描画 ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isMember(name) {
  return state.members.some(m => m.name === name);
}

// ---- クラス ----
const classOf = m => (CLASSES.includes(m.cls) ? m.cls : '');
const classLabel = c => c || '未設定';

function classMembers() {
  return currentClass === 'all' ? state.members : state.members.filter(m => classOf(m) === currentClass);
}

// 検索は部分一致。姓と名の間のスペースは無視する
const compact = s => s.replace(/\s+/g, '');
function visibleMembers() {
  const q = compact(searchQuery);
  return q ? classMembers().filter(m => compact(m.name).includes(q)) : classMembers();
}

function emptyHtml() {
  if (!state.members.length) return '<p class="empty">メンバーがいません。「メンバー」タブから追加してください</p>';
  return '<p class="empty">該当するメンバーがいません</p>';
}

// 「全員」のときはクラスごとの見出しで分け、クラスを選んでいるときはそのまま描画する
function byClassSections(members, body) {
  if (currentClass !== 'all') return body(members);
  return [...CLASSES, '']
    .map(c => [c, members.filter(m => classOf(m) === c)])
    .filter(([, list]) => list.length)
    .map(([c, list]) => `
      <h2 class="class-title">${classLabel(c)}<span class="count">${list.length}人</span></h2>
      ${body(list)}`)
    .join('');
}

function classOptions(selected) {
  return [...CLASSES, '']
    .map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>${classLabel(c)}</option>`)
    .join('');
}

function render() {
  renderHeader();
  renderInfo();
  renderTabs();
  renderClassFilter();
  renderCall();
  renderAttend();
  renderMembers();
}

function renderHeader() {
  el.me.textContent = myName && isMember(myName) ? `👤 ${myName}` : '👤 名前を選ぶ';
}

function renderInfo() {
  el.info.hidden = state.info.length === 0;
  el.info.innerHTML = `<dl>${state.info.map(i => `<dt>${esc(i.label)}</dt><dd>${esc(i.value)}</dd>`).join('')}</dl>`;
}

function renderTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === currentTab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${currentTab}`; });
}

function renderClassFilter() {
  el.classFilter.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.cls === currentClass);
  });
}

function renderCall() {
  const members = visibleMembers();
  if (!members.length) { el.call.innerHTML = emptyHtml(); return; }
  const group = (title, list, row) => `
    <h3 class="group-title">${title}<span class="count">${list.length}人</span></h3>
    <ul class="list">${list.map(row).join('') || '<li class="empty">なし</li>'}</ul>`;
  el.call.innerHTML = byClassSections(members, list =>
    group('まだ声をかけていない', list.filter(m => !m.called), m => `
      <li class="row${m.name === myName ? ' me' : ''}">
        <span class="name">${esc(m.name)}</span>
        <button class="primary small" data-act="call" data-name="${esc(m.name)}">声をかけた</button>
      </li>`) +
    group('声掛け済み', list.filter(m => m.called), m => `
      <li class="row${m.name === myName ? ' me' : ''}">
        <div class="row-main">
          <span class="name">${esc(m.name)}</span>
          <span class="sub">${esc(m.caller)} が声掛け${m.calledAt ? `・${esc(m.calledAt)}` : ''}</span>
        </div>
        <button class="ghost small" data-act="uncall" data-name="${esc(m.name)}">取り消し</button>
      </li>`));
}

const TILE_STATUSES = ['参加', '不参加', '未定', '未回答'];
const TILE_CLASS = { 参加: 'yes', 不参加: 'no', 未定: 'maybe', 未回答: 'none' };
const PARTY_LABEL = { first: '一次会', second: '二次会' };
const statusOf = (m, key) => (STATUSES.includes(m[key]) ? m[key] : '未回答');
const sum = (members, field) => members.reduce((n, m) => n + (Number(m[field]) || 0), 0);

// 集計はクラスの絞り込みだけを反映し、検索には影響されない
function summaryBlock(members, key) {
  const c = Object.fromEntries(TILE_STATUSES.map(s => [s, members.filter(m => statusOf(m, key) === s).length]));
  const joined = members.filter(m => statusOf(m, key) === '参加');
  const adults = sum(joined, `${key}Adults`);
  const kids = sum(joined, `${key}Kids`);
  const tiles = TILE_STATUSES.map(s => {
    const selected = attendFilter?.key === key && attendFilter.status === s;
    const extra = s === '参加' && (adults || kids) ? `<span class="tile-extra">+同伴者${adults} 子${kids}</span>` : '';
    return `
      <button class="tile ${TILE_CLASS[s]}${selected ? ' selected' : ''}" data-act="tile" data-key="${key}" data-status="${s}">
        <span class="tile-label">${s}</span>
        <span class="tile-num">${c[s]}<small>人</small></span>${extra}
      </button>`;
  }).join('');
  return `
    <div class="summary-block">
      <div class="summary-head">
        <span class="summary-title">${PARTY_LABEL[key]}</span>
        <span class="summary-total">合計 <b>${c.参加 + adults + kids}</b>人（本人${c.参加}・同伴者${adults}・子ども${kids}）</span>
      </div>
      <div class="tiles">${tiles}</div>
    </div>`;
}

function companionRow(m, key) {
  if (m[key] !== '参加') return '';
  const counter = (field, label) => {
    const v = Number(m[field]) || 0;
    return `
      <span class="counter">${label}
        <button data-act="comp" data-name="${esc(m.name)}" data-field="${field}" data-delta="-1"${v <= 0 ? ' disabled' : ''} aria-label="${label}を減らす">－</button>
        <b>${v}</b>
        <button data-act="comp" data-name="${esc(m.name)}" data-field="${field}" data-delta="1" aria-label="${label}を増やす">＋</button>
      </span>`;
  };
  return `<div class="companion"><span class="label">追加</span>${counter(`${key}Adults`, '同伴者')}${counter(`${key}Kids`, '子ども')}</div>`;
}

function renderAttend() {
  if (!state.members.length) { el.attend.innerHTML = emptyHtml(); return; }
  let members = visibleMembers();
  if (attendFilter) members = members.filter(m => statusOf(m, attendFilter.key) === attendFilter.status);
  const seg = (m, key) => `
    <div class="seg">${STATUSES.map(s => `
      <button class="${m[key] === s ? `on ${STATUS_CLASS[s]}` : ''}" data-act="status"
        data-name="${esc(m.name)}" data-key="${key}" data-value="${s}">${s}</button>`).join('')}
    </div>`;
  const filterChip = attendFilter ? `
    <div class="filter-chip">
      <span>${PARTY_LABEL[attendFilter.key]}・${attendFilter.status}（${members.length}人）を表示中</span>
      <button data-act="clear-tile">✕ 解除</button>
    </div>` : '';
  el.attend.innerHTML = `
    <p class="summary-caption">${currentClass === 'all' ? '全員' : currentClass}の集計（タップで絞り込み）</p>
    ${summaryBlock(classMembers(), 'first')}
    ${summaryBlock(classMembers(), 'second')}
    ${filterChip}
    ${members.length ? byClassSections(members, list => `
    <ul class="list cards">${list.map(m => `
      <li class="card${m.name === myName ? ' me' : ''}">
        <div class="card-head">
          <span class="name">${esc(m.name)}</span>
          ${m.updatedAt ? `<span class="sub">更新 ${esc(m.updatedAt)}</span>` : ''}
        </div>
        <div class="status-row"><span class="label">一次会</span>${seg(m, 'first')}</div>
        ${companionRow(m, 'first')}
        <div class="status-row"><span class="label">二次会</span>${seg(m, 'second')}</div>
        ${companionRow(m, 'second')}
        <input class="note" type="text" maxlength="200" placeholder="備考（遅れて参加 など）"
          data-act="note" data-name="${esc(m.name)}" value="${esc(m.note)}">
      </li>`).join('')}
    </ul>`) : emptyHtml()}`;
}

function renderMembers() {
  const members = visibleMembers();
  if (!members.length) {
    el.memberList.innerHTML = emptyHtml();
    return;
  }
  el.memberList.innerHTML = byClassSections(members, list => `
    <ul class="list">${list.map(m => `
      <li class="row">
        <span class="name">${esc(m.name)}</span>
        <div class="row-actions">
          <button class="ghost small" data-act="edit" data-name="${esc(m.name)}">編集</button>
          <button class="danger small" data-act="remove" data-name="${esc(m.name)}">削除</button>
        </div>
      </li>`).join('')}
    </ul>`);
}

// ---- ダイアログ ----
// validate が false を返すと閉じずに入力を続けてもらう
function ask(dialog, validate) {
  return new Promise(resolve => {
    const onSubmit = e => {
      if (e.submitter?.value === 'ok' && validate && !validate()) e.preventDefault();
    };
    dialog.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('submit', onSubmit);
      resolve(dialog.returnValue === 'ok');
    }, { once: true });
    dialog.returnValue = '';
    dialog.showModal();
  });
}

// クラスごとにまとめた選択肢
function nameOptions(selected) {
  return [...CLASSES, '']
    .map(c => [c, state.members.filter(m => classOf(m) === c)])
    .filter(([, list]) => list.length)
    .map(([c, list]) => `<optgroup label="${classLabel(c)}">${list
      .map(m => `<option value="${esc(m.name)}"${m.name === selected ? ' selected' : ''}>${esc(m.name)}</option>`)
      .join('')}</optgroup>`)
    .join('');
}

async function chooseMyName() {
  if (!state.members.length) {
    toast('先に「メンバー」タブで自分の名前を追加してください', 'error');
    currentTab = 'members';
    renderTabs();
    return;
  }
  const select = $('me-select');
  select.innerHTML = `<option value="">（選んでください）</option>${nameOptions(myName)}`;
  if (await ask($('me-dialog'))) {
    setMyName(select.value);
    render();
  }
}

async function recordCall(name) {
  const select = $('caller-select');
  const other = $('caller-other');
  const defaultCaller = isMember(myName) ? myName : '';
  $('caller-title').textContent = `${name} さんに声をかけた`;
  select.innerHTML = `<option value="">（選んでください）</option>${nameOptions(defaultCaller)}<option value="${OTHER}">その他（自由入力）</option>`;
  other.value = '';
  other.hidden = true;
  select.onchange = () => {
    other.hidden = select.value !== OTHER;
    if (!other.hidden) other.focus();
  };
  const callerName = () => (select.value === OTHER ? other.value.trim() : select.value);
  const ok = await ask($('caller-dialog'), () => {
    if (callerName()) return true;
    toast('声をかけた人を選んでください', 'error');
    return false;
  });
  if (ok) await run('call', { name, caller: callerName() });
}

async function editMember(oldName) {
  const last = $('edit-last');
  const first = $('edit-first');
  const error = $('edit-error');
  const member = state.members.find(m => m.name === oldName);
  const oldClass = member ? classOf(member) : '';
  [last.value, first.value] = splitName(oldName);
  el.editClass.innerHTML = classOptions(oldClass);
  error.hidden = true;
  const ok = await ask($('edit-dialog'), () => {
    const msg = nameError(joinName(last.value, first.value), oldName);
    error.textContent = msg;
    error.hidden = !msg;
    return !msg;
  });
  const newName = joinName(last.value, first.value);
  const cls = el.editClass.value;
  if (!ok || (newName === oldName && cls === oldClass)) return;
  if (await run('rename', { oldName, newName, cls }) && myName === oldName) {
    setMyName(newName);
    render();
  }
}

async function removeMember(name) {
  if (!confirm(`「${name}」を削除しますか？\n声掛け・参加可否の記録も消えます。`)) return;
  if (await run('remove', { name }) && myName === name) {
    setMyName('');
    render();
  }
}

function saveAttendance(name, changes) {
  const m = state.members.find(x => x.name === name);
  if (!m) return;
  // 備考の保存直後に参加可否を押した場合でも備考を巻き戻さないよう、先に手元へ反映する
  Object.assign(m, changes);
  // 参加以外にしたら、その会の同伴者は 0 に戻す
  ['first', 'second'].forEach(key => {
    if (m[key] !== '参加') m[`${key}Adults`] = m[`${key}Kids`] = 0;
  });
  run('attend', {
    name, first: m.first, second: m.second, note: m.note,
    firstAdults: m.firstAdults, firstKids: m.firstKids, secondAdults: m.secondAdults, secondKids: m.secondKids,
  });
}

async function bulkAdd() {
  const lines = el.bulkNames.value.split('\n').filter(l => l.trim());
  const invalid = lines.filter(l => !parseLine(l));
  const showError = msg => {
    el.bulkError.textContent = msg;
    el.bulkError.hidden = !msg;
  };
  if (!lines.length) return showError('名前を貼り付けてください');
  if (invalid.length) return showError(`姓と名の間にスペースがない行があります：${invalid.join('、')}`);
  showError('');
  const res = await run('addMany', { names: lines.map(parseLine), cls: el.bulkClass.value });
  if (!res) return;
  const { added, skipped } = res.result;
  el.bulkNames.value = '';
  if (skipped.length) {
    showError(`${added}人を追加しました。次の${skipped.length}件は追加していません：\n${skipped.join('\n')}`);
  }
}

// ---- イベント ----
document.querySelector('.tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  currentTab = tab.dataset.tab;
  store.set('bonenkai.tab', currentTab);
  renderTabs();
});

document.addEventListener('click', e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, name } = btn.dataset;
  if (act === 'call') recordCall(name);
  else if (act === 'uncall') {
    if (confirm(`「${name}」の声掛けを取り消しますか？`)) run('uncall', { name });
  } else if (act === 'status') {
    const { key } = btn.dataset;
    const m = state.members.find(x => x.name === name);
    // 選択中のボタンをもう一度押すと未回答に戻す
    const value = m && m[key] === btn.dataset.value ? '' : btn.dataset.value;
    const message = value
      ? `${name} さんの${PARTY_LABEL[key]}を「${value}」にします。よろしいですか？`
      : `${name} さんの${PARTY_LABEL[key]}を未回答に戻します。よろしいですか？`;
    if (confirm(message)) saveAttendance(name, { [key]: value });
  } else if (act === 'comp') {
    const m = state.members.find(x => x.name === name);
    if (!m) return;
    const { field } = btn.dataset;
    const value = Math.max(0, (Number(m[field]) || 0) + Number(btn.dataset.delta));
    saveAttendance(name, { [field]: value });
  } else if (act === 'tile') {
    const { key, status } = btn.dataset;
    const same = attendFilter?.key === key && attendFilter.status === status;
    attendFilter = same ? null : { key, status };
    renderAttend();
  } else if (act === 'clear-tile') {
    attendFilter = null;
    renderAttend();
  } else if (act === 'edit') editMember(name);
  else if (act === 'remove') removeMember(name);
});

document.addEventListener('change', e => {
  if (e.target.dataset.act === 'note') saveAttendance(e.target.dataset.name, { note: e.target.value.trim() });
});

// 入力途中は重複の警告だけをすぐに出す
function checkAddDuplicate() {
  const msg = nameError(joinName(el.addLast.value, el.addFirst.value));
  el.addError.textContent = msg.startsWith('⚠') ? msg : '';
  el.addError.hidden = !el.addError.textContent;
}
el.addLast.addEventListener('input', checkAddDuplicate);
el.addFirst.addEventListener('input', checkAddDuplicate);

el.addForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = joinName(el.addLast.value, el.addFirst.value);
  const msg = nameError(name);
  el.addError.textContent = msg;
  el.addError.hidden = !msg;
  if (msg) return;
  const askMe = !isMember(myName) && !askedMyName;
  askedMyName = true;
  if (!(await run('add', { name, cls: el.addClass.value }))) return;
  el.addLast.value = '';
  el.addFirst.value = '';
  if (askMe && confirm(`「${name}」をあなたの名前として設定しますか？`)) {
    setMyName(name);
    render();
  }
});

el.classFilter.addEventListener('click', e => {
  const btn = e.target.closest('button[data-cls]');
  if (!btn) return;
  currentClass = btn.dataset.cls;
  store.set('bonenkai.class', currentClass);
  render();
});

// 追加先のクラスは、絞り込み中のクラスを初期値にする
function syncAddClass() {
  const cls = CLASSES.includes(currentClass) ? currentClass : CLASSES[0];
  el.addClass.innerHTML = classOptions(cls);
  el.bulkClass.innerHTML = classOptions(cls);
}
el.classFilter.addEventListener('click', syncAddClass);
syncAddClass();

$('search').addEventListener('input', e => {
  searchQuery = e.target.value;
  renderCall();
  renderAttend();
  renderMembers();
});

$('bulk-btn').addEventListener('click', bulkAdd);
el.me.addEventListener('click', chooseMyName);
$('refresh-btn').addEventListener('click', () => run('list'));

// アプリに戻ってきたとき、30秒以上たっていれば最新を取得する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFetched > 30000) run('list');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしでも動作する */ });
}

render();
run('list').then(ok => {
  if (ok && !isMember(myName) && state.members.length) chooseMyName();
});
