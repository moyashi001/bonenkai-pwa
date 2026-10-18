'use strict';

const STATUSES = ['参加', '不参加', '未定'];
const STATUS_CLASS = { 参加: 'yes', 不参加: 'no', 未定: 'maybe' };
const NAME_RE = /^[ぁ-ゖー]+(（[^（）]+）)?$/;
const OTHER = '__other__';
const collator = new Intl.Collator('ja');
const byName = (a, b) => collator.compare(a.name, b.name);

const $ = id => document.getElementById(id);
const el = {
  me: $('me-btn'),
  info: $('info'),
  call: $('tab-call'),
  attend: $('tab-attend'),
  memberList: $('member-list'),
  addForm: $('add-form'),
  addName: $('add-name'),
  addError: $('add-error'),
  busy: $('busy'),
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
// 名前を追加したとき「自分として設定するか」を聞くのは1回だけ
let askedMyName = false;

function setMyName(name) {
  myName = name;
  store.set('bonenkai.myName', name);
}

// ---- 名前の正規化とチェック ----
function normalizeName(s) {
  return s
    .replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');
}

function nameError(name, exclude) {
  if (!name) return '名前を入力してください';
  if (!NAME_RE.test(name)) return 'ひらがなで入力してください（補足は「たなか（営業）」のように括弧で）';
  if (name !== exclude && state.members.some(m => m.name === name)) {
    return `⚠ 「${name}」はすでに登録されています。同じ名前の人なら「${name}（営業）」のように区別してください`;
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
  state = json.data;
  lastFetched = Date.now();
  render();
}

async function run(action, params, busyText = '保存中…') {
  el.busy.textContent = busyText;
  el.busy.hidden = false;
  try {
    await api(action, params);
    return true;
  } catch (err) {
    toast(err.message.startsWith('Failed to fetch') ? '通信できませんでした。電波を確認してください' : err.message);
    return false;
  } finally {
    el.busy.hidden = true;
  }
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4000);
}

// ---- 描画 ----
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function sortedMembers() {
  return [...state.members].sort(byName);
}

function isMember(name) {
  return state.members.some(m => m.name === name);
}

function render() {
  renderHeader();
  renderInfo();
  renderTabs();
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

const EMPTY = '<p class="empty">メンバーがいません。「メンバー」タブから追加してください</p>';

function renderCall() {
  const members = sortedMembers();
  if (!members.length) { el.call.innerHTML = EMPTY; return; }
  const group = (title, list, row) => `
    <h2 class="group-title">${title}<span class="count">${list.length}人</span></h2>
    <ul class="list">${list.map(row).join('') || '<li class="empty">なし</li>'}</ul>`;
  el.call.innerHTML =
    group('まだ声をかけていない', members.filter(m => !m.called), m => `
      <li class="row${m.name === myName ? ' me' : ''}">
        <span class="name">${esc(m.name)}</span>
        <button class="primary small" data-act="call" data-name="${esc(m.name)}">声をかけた</button>
      </li>`) +
    group('声掛け済み', members.filter(m => m.called), m => `
      <li class="row${m.name === myName ? ' me' : ''}">
        <div class="row-main">
          <span class="name">${esc(m.name)}</span>
          <span class="sub">${esc(m.caller)} が声掛け${m.calledAt ? `・${esc(m.calledAt)}` : ''}</span>
        </div>
        <button class="ghost small" data-act="uncall" data-name="${esc(m.name)}">取り消し</button>
      </li>`);
}

function counts(key) {
  const c = { 参加: 0, 不参加: 0, 未定: 0, 未回答: 0 };
  state.members.forEach(m => { c[STATUSES.includes(m[key]) ? m[key] : '未回答']++; });
  return c;
}

function renderAttend() {
  const members = sortedMembers();
  if (!members.length) { el.attend.innerHTML = EMPTY; return; }
  const summaryRow = (label, key) => {
    const c = counts(key);
    return `<tr><th>${label}</th>${['参加', '不参加', '未定', '未回答'].map(s => `<td>${c[s]}</td>`).join('')}</tr>`;
  };
  const seg = (m, key) => `
    <div class="seg">${STATUSES.map(s => `
      <button class="${m[key] === s ? `on ${STATUS_CLASS[s]}` : ''}" data-act="status"
        data-name="${esc(m.name)}" data-key="${key}" data-value="${s}">${s}</button>`).join('')}
    </div>`;
  el.attend.innerHTML = `
    <table class="summary">
      <thead><tr><th></th><th>参加</th><th>不参加</th><th>未定</th><th>未回答</th></tr></thead>
      <tbody>${summaryRow('一次会', 'first')}${summaryRow('二次会', 'second')}</tbody>
    </table>
    <ul class="list cards">${members.map(m => `
      <li class="card${m.name === myName ? ' me' : ''}">
        <div class="card-head">
          <span class="name">${esc(m.name)}</span>
          ${m.updatedAt ? `<span class="sub">更新 ${esc(m.updatedAt)}</span>` : ''}
        </div>
        <div class="status-row"><span class="label">一次会</span>${seg(m, 'first')}</div>
        <div class="status-row"><span class="label">二次会</span>${seg(m, 'second')}</div>
        <input class="note" type="text" maxlength="200" placeholder="備考（遅れて参加 など）"
          data-act="note" data-name="${esc(m.name)}" value="${esc(m.note)}">
      </li>`).join('')}
    </ul>`;
}

function renderMembers() {
  const members = sortedMembers();
  el.memberList.innerHTML = members.map(m => `
    <li class="row">
      <span class="name">${esc(m.name)}</span>
      <div class="row-actions">
        <button class="ghost small" data-act="edit" data-name="${esc(m.name)}">編集</button>
        <button class="danger small" data-act="remove" data-name="${esc(m.name)}">削除</button>
      </div>
    </li>`).join('') || '<li class="empty">まだ登録されていません</li>';
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

function nameOptions(selected) {
  return sortedMembers()
    .map(m => `<option value="${esc(m.name)}"${m.name === selected ? ' selected' : ''}>${esc(m.name)}</option>`)
    .join('');
}

async function chooseMyName() {
  if (!state.members.length) {
    toast('先に「メンバー」タブで自分の名前を追加してください');
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
    toast('声をかけた人を選んでください');
    return false;
  });
  if (ok) await run('call', { name, caller: callerName() });
}

async function editMember(oldName) {
  const input = $('edit-name');
  const error = $('edit-error');
  input.value = oldName;
  error.hidden = true;
  const ok = await ask($('edit-dialog'), () => {
    const msg = nameError(normalizeName(input.value), oldName);
    error.textContent = msg;
    error.hidden = !msg;
    return !msg;
  });
  const newName = normalizeName(input.value);
  if (!ok || newName === oldName) return;
  if (await run('rename', { oldName, newName }) && myName === oldName) {
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
  run('attend', { name, first: m.first, second: m.second, note: m.note });
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
    const m = state.members.find(x => x.name === name);
    // 選択中のボタンをもう一度押すと未回答に戻す
    const value = m && m[btn.dataset.key] === btn.dataset.value ? '' : btn.dataset.value;
    saveAttendance(name, { [btn.dataset.key]: value });
  } else if (act === 'edit') editMember(name);
  else if (act === 'remove') removeMember(name);
});

document.addEventListener('change', e => {
  if (e.target.dataset.act === 'note') saveAttendance(e.target.dataset.name, { note: e.target.value.trim() });
});

el.addName.addEventListener('input', () => {
  const msg = el.addName.value ? nameError(normalizeName(el.addName.value)) : '';
  // 入力途中の「ひらがなで」警告は出さず、重複の警告だけすぐに出す
  el.addError.textContent = msg.startsWith('⚠') ? msg : '';
  el.addError.hidden = !el.addError.textContent;
});

el.addForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = normalizeName(el.addName.value);
  const msg = nameError(name);
  el.addError.textContent = msg;
  el.addError.hidden = !msg;
  if (msg) return;
  const askMe = !isMember(myName) && !askedMyName;
  askedMyName = true;
  if (!(await run('add', { name }))) return;
  el.addName.value = '';
  if (askMe && confirm(`「${name}」をあなたの名前として設定しますか？`)) {
    setMyName(name);
    render();
  }
});

el.me.addEventListener('click', chooseMyName);
$('refresh-btn').addEventListener('click', () => run('list', {}, '読み込み中…'));

// アプリに戻ってきたとき、30秒以上たっていれば最新を取得する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFetched > 30000) {
    run('list', {}, '読み込み中…');
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン対応なしでも動作する */ });
}

render();
run('list', {}, '読み込み中…').then(ok => {
  if (ok && !isMember(myName) && state.members.length) chooseMyName();
});
