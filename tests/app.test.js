// 画面の動作テスト。GAS の代わりに fetch をモックして app.js を jsdom 上で動かす
// 実行：npm install && npm test
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src[^>]*><\/script>/g, '');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const member = (name, cls, o = {}) => ({
  name, cls, called: false, caller: '', calledAt: '', assignee: '',
  first: '', second: '', note: '', updatedAt: '',
  firstAdults: 0, firstKids: 0, secondAdults: 0, secondKids: 0, ...o,
});

const defaultMembers = () => [
  member('池田 紀代子', '1組', { first: '参加', firstAdults: 1, firstKids: 2, note: '遅れます' }),
  member('桶野 百子', '1組', { first: '不参加', assignee: '甲斐 敦子' }),
  member('甲斐 敦子', '2組', { first: '参加', called: true, caller: '池田 紀代子', calledAt: '10/18 12:00' }),
  member('青山 裕加里', '2組'),
];

// app.js を読み込み、初回の読み込みが終わるまで待つ
async function loadApp({ members = defaultMembers(), result, eventName = '同窓会' } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'https://bonenkai-pwa.vercel.app/' });
  const w = dom.window;
  const ctx = { w, d: w.document, sent: [], confirms: [], shared: null, members };
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.fetch = async (url, opts) => {
    if (opts) ctx.sent.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true, data: { members, info: [], eventName, result: opts ? result : undefined } }) };
  };
  w.GAS_URL = 'https://script.google.com/macros/s/test/exec';
  w.confirm = message => { ctx.confirms.push(message); return true; };
  w.navigator.share = async ({ text }) => { ctx.shared = text; };
  w.eval(APP);
  await tick();
  return ctx;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));
const texts = (d, selector) => [...d.querySelectorAll(selector)].map(e => e.textContent.trim());
const closeDialog = (ctx, id, value) => {
  const dialog = ctx.d.getElementById(id);
  dialog.returnValue = value;
  dialog.open = false;
  dialog.dispatchEvent(new ctx.w.Event('close'));
};
const type = (ctx, id, value) => {
  const input = ctx.d.getElementById(id);
  input.value = value;
  input.dispatchEvent(new ctx.w.Event('input'));
};

test('イベント名をタイトルに表示し、未設定なら「参加管理」だけにする', async () => {
  const { d } = await loadApp();
  assert.equal(d.getElementById('app-title').textContent, '同窓会 参加管理');
  assert.equal(d.title, '同窓会 参加管理');
  const { d: d2 } = await loadApp({ eventName: '' });
  assert.equal(d2.getElementById('app-title').textContent, '参加管理');
});

test('全員表示ではクラスごとの見出しで分け、クラスを選ぶとそのクラスだけ表示する', async () => {
  const { d } = await loadApp({ members: [...defaultMembers(), member('てすと たろう', '')] });
  assert.deepEqual(texts(d, '#tab-call .class-title').map(t => t.replace(/\s+/g, '')), ['1組2人', '2組2人', '未設定1人']);
  d.querySelector('[data-cls="2組"]').click();
  // 声掛けタブは「まだ声をかけていない」→「声掛け済み」の順
  assert.deepEqual(texts(d, '#tab-call .name'), ['青山 裕加里', '甲斐 敦子']);
  assert.equal(d.getElementById('add-class').value, '2組');
});

test('検索は全タブで部分一致し、姓名間のスペースを無視する', async () => {
  const ctx = await loadApp();
  const { d } = ctx;
  type(ctx, 'search', '池田紀代');
  assert.deepEqual(texts(d, '#tab-call .name'), ['池田 紀代子']);
  assert.deepEqual(texts(d, '#tab-attend .card .name'), ['池田 紀代子']);
  assert.deepEqual(texts(d, '#member-list .name'), ['池田 紀代子']);
});

test('メンバー追加で重複を警告し、まとめて追加は不正な行を止めてクラス付きで送る', async () => {
  const ctx = await loadApp({ result: { added: 1, skipped: ['「池田 紀代子」はすでに登録されています'] } });
  const { d } = ctx;
  type(ctx, 'add-last', '池田');
  type(ctx, 'add-first', '紀代子');
  assert.match(d.getElementById('add-error').textContent, /すでに登録されています/);

  d.getElementById('bulk-names').value = '鈴木 雄一郎\n三好恭子';
  d.getElementById('bulk-btn').click();
  assert.match(d.getElementById('bulk-error').textContent, /スペースがない行があります：三好恭子/);
  assert.equal(ctx.sent.length, 0);

  d.getElementById('bulk-class').value = '2組';
  d.getElementById('bulk-names').value = '鈴木　雄一郎\n池田 紀代子';
  d.getElementById('bulk-btn').click();
  await tick();
  assert.deepEqual(ctx.sent.at(-1), { action: 'addMany', names: ['鈴木 雄一郎', '池田 紀代子'], cls: '2組' });
  assert.match(d.getElementById('bulk-error').textContent, /1人を追加しました/);
});

test('集計タイルは同伴者を含めて数え、タップで絞り込み、もう一度タップで解除する', async () => {
  const { d } = await loadApp();
  assert.match(d.querySelector('.summary-total').textContent.replace(/\s+/g, ''), /合計5人（本人2・同伴者1・子ども2）/);
  const tile = () => d.querySelector('.tile[data-key="first"][data-status="参加"]');
  tile().click();
  assert.deepEqual(texts(d, '#tab-attend .card .name'), ['池田 紀代子', '甲斐 敦子']);
  assert.match(d.querySelector('.filter-chip').textContent, /一次会・参加（2人）/);
  tile().click();
  assert.equal(d.querySelectorAll('#tab-attend .card').length, 4);
});

test('参加可否の変更は確認を出し、参加以外にすると同伴者を0に戻す', async () => {
  const ctx = await loadApp();
  ctx.d.querySelector('[data-act="status"][data-name="池田 紀代子"][data-key="first"][data-value="不参加"]').click();
  await tick();
  assert.equal(ctx.confirms.at(-1), '池田 紀代子 さんの一次会を「不参加」にします。よろしいですか？');
  assert.equal(ctx.sent.at(-1).first, '不参加');
  assert.equal(ctx.sent.at(-1).firstAdults, 0);
  assert.equal(ctx.sent.at(-1).firstKids, 0);

  ctx.d.querySelector('[data-act="status"][data-name="甲斐 敦子"][data-key="first"][data-value="参加"]').click();
  assert.equal(ctx.confirms.at(-1), '甲斐 敦子 さんの一次会を未回答に戻します。よろしいですか？');
});

test('同伴者の＋で人数を保存する', async () => {
  const ctx = await loadApp();
  ctx.d.querySelector('[data-act="comp"][data-name="甲斐 敦子"][data-field="firstAdults"][data-delta="1"]').click();
  await tick();
  assert.equal(ctx.sent.at(-1).action, 'attend');
  assert.equal(ctx.sent.at(-1).firstAdults, 1);
});

test('声をかけたときは担当者が初期値になり、選んだ人を次回の初期値として覚える', async () => {
  const ctx = await loadApp();
  const { d } = ctx;
  d.querySelector('[data-act="call"][data-name="桶野 百子"]').click();
  assert.match(d.getElementById('pick-prompt').textContent, /あなたの名前を選んでください/);
  assert.equal(d.getElementById('pick-selected').textContent, '選択中：甲斐 敦子');
  d.querySelector('[data-pick="青山 裕加里"]').click();
  closeDialog(ctx, 'pick-dialog', 'ok');
  await tick();
  assert.deepEqual(ctx.sent.at(-1), { action: 'call', name: '桶野 百子', caller: '青山 裕加里' });
  assert.equal(ctx.w.localStorage.getItem('bonenkai.lastPicked'), '青山 裕加里');

  const count = ctx.sent.length;
  d.querySelector('[data-act="call"][data-name="青山 裕加里"]').click();
  closeDialog(ctx, 'pick-dialog', 'cancel');
  await tick();
  assert.equal(ctx.sent.length, count);
});

test('担当は自由入力でも登録でき、「担当を外す」で解除する', async () => {
  const ctx = await loadApp();
  const { d } = ctx;
  d.querySelector('[data-act="assign"][data-name="青山 裕加里"]').click();
  assert.equal(d.getElementById('pick-clear').hidden, true);
  type(ctx, 'pick-other', '幹事 太郎');
  closeDialog(ctx, 'pick-dialog', 'ok');
  await tick();
  assert.deepEqual(ctx.sent.at(-1), { action: 'assign', name: '青山 裕加里', assignee: '幹事 太郎' });

  d.querySelector('[data-act="assign"][data-name="桶野 百子"]').click();
  assert.equal(d.getElementById('pick-clear').hidden, false);
  closeDialog(ctx, 'pick-dialog', 'clear');
  await tick();
  assert.deepEqual(ctx.sent.at(-1), { action: 'assign', name: '桶野 百子', assignee: '' });
});

test('共有テキストは絞り込み中なら一覧、そうでなければ集計を出し、URLを付ける', async () => {
  const ctx = await loadApp();
  const { d } = ctx;
  d.querySelector('[data-act="share"]').click();
  await tick();
  assert.match(ctx.shared, /^【同窓会 参加状況】/);
  assert.match(ctx.shared, /一次会：参加2人（同伴含め5人）／不参加1／未定0／未回答1/);
  assert.match(ctx.shared, /回答・確認はこちら：https:\/\/bonenkai-pwa\.vercel\.app\//);

  d.querySelector('.tile[data-key="first"][data-status="参加"]').click();
  d.querySelector('[data-act="share"]').click();
  await tick();
  assert.match(ctx.shared, /【同窓会】一次会・参加（2人）/);
  assert.match(ctx.shared, /・池田 紀代子（同伴者1・子ども2） ※遅れます/);
  assert.match(ctx.shared, /■2組\n・甲斐 敦子/);
});
