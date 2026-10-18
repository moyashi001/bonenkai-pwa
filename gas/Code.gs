// イベント参加管理（同窓会・忘年会など） - Google Apps Script
// スプレッドシートの「拡張機能 > Apps Script」に貼り付けて使う

const SHEET_CALL = '声掛け';
const SHEET_ATTEND = '参加管理';
const SHEET_INFO = '開催情報';
const SHEET_LOG = '変更履歴';
const CALL_HEADER = ['名前', '声掛け済み', '声をかけた人', '更新日時', 'クラス', '担当'];
const COMPANION_HEADER = ['一次会大人', '一次会子ども', '二次会大人', '二次会子ども'];
const COMPANION_KEYS = ['firstAdults', 'firstKids', 'secondAdults', 'secondKids'];
const ATTEND_HEADER = ['名前', '一次会', '二次会', '備考', '更新日時', 'クラス', ...COMPANION_HEADER];
const LOG_HEADER = ['日時', '操作', '対象', '内容'];
const CALL_CLASS_COL = 5;
const CALL_ASSIGNEE_COL = 6;
const ATTEND_CLASS_COL = 6;
const COMPANION_COL = 7;
const EVENT_NAME_KEY = 'イベント名';
const INFO_KEYS = [EVENT_NAME_KEY, '日時', '場所', '会費', '回答期限', '二次会の場所'];
const STATUSES = ['参加', '不参加', '未定'];
const CLASSES = ['1組', '2組'];
const TZ = 'Asia/Tokyo';

// 初回に1度だけ GAS エディタから実行する
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_CALL, CALL_HEADER);
  const attend = ensureSheet_(ss, SHEET_ATTEND, ATTEND_HEADER);
  const info = ensureSheet_(ss, SHEET_INFO, ['項目', '内容']);
  ensureSheet_(ss, SHEET_LOG, LOG_HEADER);
  if (info.getLastRow() < 2) {
    info.getRange(2, 1, INFO_KEYS.length, 1).setValues(INFO_KEYS.map(k => [k]));
  }
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();
  attend.getRange('B2:C').setDataValidation(rule);
}

function ensureSheet_(ss, name, header) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doGet() {
  return respond_(() => readState_());
}

function doPost(e) {
  return respond_(() => {
    const req = JSON.parse(e.postData.contents);
    const action = ACTIONS[req.action];
    if (!action) throw new Error('不明な操作です: ' + req.action);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let result;
    try {
      result = action(sheets_(), req);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return { ...readState_(), result };
  });
}

function respond_(fn) {
  let body;
  try {
    body = { ok: true, data: fn() };
  } catch (err) {
    body = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

const ACTIONS = {
  add(s, req) {
    const { skipped } = ACTIONS.addMany(s, { names: [req.name], cls: req.cls });
    if (skipped.length) throw new Error(skipped[0]);
  },

  // 登録済み・形式不正の名前は飛ばし、残りを並び順のまま末尾に追加する
  addMany(s, req) {
    const cls = class_(req.cls);
    const exists = new Set([...dataRows_(s.call), ...dataRows_(s.attend)].map(r => r[0]));
    const added = [];
    const skipped = [];
    (req.names || []).forEach(raw => {
      let name;
      try {
        name = validName_(raw);
      } catch (err) {
        skipped.push(`${raw}（${err.message}）`);
        return;
      }
      if (exists.has(name)) {
        skipped.push(`「${name}」はすでに登録されています`);
        return;
      }
      exists.add(name);
      added.push(name);
    });
    if (added.length) {
      const callStart = s.call.getLastRow() + 1;
      s.call.getRange(callStart, 1, added.length, 6).setValues(added.map(n => [n, false, '', '', cls, '']));
      s.call.getRange(callStart, 2, added.length, 1).insertCheckboxes();
      const attendStart = s.attend.getLastRow() + 1;
      s.attend.getRange(attendStart, 1, added.length, 6).setValues(added.map(n => [n, '', '', '', '', cls]));
      log_(s, 'メンバー追加', added.length === 1 ? added[0] : `${added.length}人`,
        `${cls || 'クラス未設定'}${added.length > 1 ? '：' + added.join('、') : ''}`);
    }
    return { added: added.length, skipped };
  },

  // 名前とクラスを変更する
  rename(s, req) {
    const oldName = String(req.oldName);
    requireMember_(s, oldName);
    const name = newName_(s, req.newName, oldName);
    const cls = class_(req.cls);
    let oldClass = '';
    [[s.call, CALL_CLASS_COL], [s.attend, ATTEND_CLASS_COL]].forEach(([sheet, classCol]) => {
      const row = findRow_(sheet, oldName);
      if (!row) return;
      oldClass = oldClass || String(sheet.getRange(row, classCol).getValue());
      sheet.getRange(row, 1).setValue(name);
      sheet.getRange(row, classCol).setValue(cls);
    });
    // 「声をかけた人」「担当」に書かれた旧名も新しい名前にそろえる
    [3, CALL_ASSIGNEE_COL].forEach(col => replaceInColumn_(s.call, col, oldName, name));
    const changes = [];
    if (name !== oldName) changes.push(`名前：${oldName}→${name}`);
    if (cls !== oldClass) changes.push(`クラス：${oldClass || '未設定'}→${cls || '未設定'}`);
    if (changes.length) log_(s, 'メンバー編集', name, changes.join('、'));
  },

  remove(s, req) {
    const name = String(req.name);
    let removed = false;
    [s.call, s.attend].forEach(sheet => {
      const row = findRow_(sheet, name);
      if (!row) return;
      sheet.deleteRow(row);
      removed = true;
    });
    if (removed) log_(s, 'メンバー削除', name, '');
  },

  call(s, req) {
    const caller = safeText_(req.caller, 50);
    if (!caller) throw new Error('声をかけた人を選んでください');
    const name = String(req.name);
    const row = callRow_(s, name);
    s.call.getRange(row, 2, 1, 3).setValues([[true, caller, new Date()]]);
    log_(s, '声掛け', name, `声をかけた人：${caller}`);
  },

  uncall(s, req) {
    const name = String(req.name);
    const row = callRow_(s, name);
    const caller = s.call.getRange(row, 3).getValue();
    s.call.getRange(row, 2, 1, 3).setValues([[false, '', new Date()]]);
    log_(s, '声掛け取消', name, caller ? `取り消した記録：${caller}` : '');
  },

  // 声掛けの担当を設定する（空なら担当を外す）
  assign(s, req) {
    const name = String(req.name);
    const assignee = safeText_(req.assignee, 50);
    const row = callRow_(s, name);
    const cell = s.call.getRange(row, CALL_ASSIGNEE_COL);
    const before = String(cell.getValue());
    cell.setValue(assignee);
    log_(s, assignee ? '担当設定' : '担当解除', name, `${before || 'なし'}→${assignee || 'なし'}`);
  },

  attend(s, req) {
    const name = String(req.name);
    requireMember_(s, name);
    const first = status_(req.first);
    const second = status_(req.second);
    const note = safeText_(req.note, 200);
    // 同伴者は「参加」のときだけ数える
    const companions = COMPANION_KEYS.map(k =>
      (k.startsWith('first') ? first : second) === '参加' ? count_(req[k]) : 0);
    let row = findRow_(s.attend, name);
    if (!row) {
      s.attend.appendRow([name]);
      row = s.attend.getLastRow();
    }
    const [oldFirst, oldSecond, oldNote] = s.attend.getRange(row, 2, 1, 3).getValues()[0].map(String);
    const oldCompanions = s.attend.getRange(row, COMPANION_COL, 1, companions.length).getValues()[0].map(v => Number(v) || 0);
    s.attend.getRange(row, 2, 1, 4).setValues([[first, second, note, new Date()]]);
    s.attend.getRange(row, COMPANION_COL, 1, companions.length).setValues([companions]);

    const party = (status, adults, kids) => (status || '未回答') +
      (status === '参加' && (adults || kids) ? `（同伴者${adults}・子ども${kids}）` : '');
    const changes = [];
    const before1 = party(oldFirst, oldCompanions[0], oldCompanions[1]);
    const after1 = party(first, companions[0], companions[1]);
    if (before1 !== after1) changes.push(`一次会：${before1}→${after1}`);
    const before2 = party(oldSecond, oldCompanions[2], oldCompanions[3]);
    const after2 = party(second, companions[2], companions[3]);
    if (before2 !== after2) changes.push(`二次会：${before2}→${after2}`);
    if (oldNote !== note) changes.push(`備考：「${oldNote}」→「${note}」`);
    if (changes.length) log_(s, '参加可否', name, changes.join('、'));
  },
};

function sheets_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const s = {
    call: ss.getSheetByName(SHEET_CALL),
    attend: ss.getSheetByName(SHEET_ATTEND),
    info: ss.getSheetByName(SHEET_INFO),
  };
  if (!s.call || !s.attend || !s.info) {
    throw new Error('シートがありません。GASエディタで setup を実行してください');
  }
  // 後から追加した列（クラス・同伴者・担当）の見出しがない既存シートには見出しを足す
  ensureHeader_(s.call, CALL_HEADER);
  ensureHeader_(s.attend, ATTEND_HEADER);
  s.log = ensureSheet_(ss, SHEET_LOG, LOG_HEADER);
  ensureEventNameRow_(s.info);
  return s;
}

// 「イベント名」の行がない既存の開催情報シートには、先頭に空の行を足す
function ensureEventNameRow_(info) {
  const last = info.getLastRow();
  const labels = last >= 2 ? info.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
  if (labels.includes(EVENT_NAME_KEY)) return;
  info.insertRowAfter(1);
  info.getRange(2, 1, 1, 2).setValues([[EVENT_NAME_KEY, '']]);
}

function ensureHeader_(sheet, header) {
  const range = sheet.getRange(1, 1, 1, header.length);
  if (range.getValues()[0].some((v, i) => v !== header[i])) {
    range.setValues([header]).setFontWeight('bold');
  }
}

// 変更履歴は新しいものが上に来るよう、見出しの直下に挿入する
function log_(s, op, target, detail) {
  s.log.insertRowAfter(1);
  s.log.getRange(2, 1, 1, 4).setValues([[new Date(), op, safeText_(target, 100), safeText_(detail, 1000)]]);
}

function replaceInColumn_(sheet, col, from, to) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const range = sheet.getRange(2, col, last - 1, 1);
  range.setValues(range.getValues().map(([v]) => [String(v) === from ? to : v]));
}

function readState_() {
  const s = sheets_();
  const members = new Map();
  const member = name => {
    if (!members.has(name)) {
      members.set(name, {
        name, cls: '', called: false, caller: '', calledAt: '', assignee: '',
        first: '', second: '', note: '', updatedAt: '',
        firstAdults: 0, firstKids: 0, secondAdults: 0, secondKids: 0,
      });
    }
    return members.get(name);
  };
  dataRows_(s.call).forEach(r => {
    const m = member(r[0]);
    m.called = r[1] === true;
    m.caller = String(r[2]);
    m.calledAt = r[1] === true ? formatDate_(r[3]) : '';
    m.cls = String(r[CALL_CLASS_COL - 1] || '');
    m.assignee = String(r[CALL_ASSIGNEE_COL - 1] || '');
  });
  dataRows_(s.attend).forEach(r => {
    const m = member(r[0]);
    m.first = String(r[1]);
    m.second = String(r[2]);
    m.note = String(r[3]);
    m.updatedAt = formatDate_(r[4]);
    m.cls = m.cls || String(r[ATTEND_CLASS_COL - 1] || '');
    COMPANION_KEYS.forEach((k, i) => { m[k] = Number(r[COMPANION_COL - 1 + i]) || 0; });
  });
  const rows = s.info.getDataRange().getDisplayValues().slice(1);
  const eventName = (rows.find(([label]) => label === EVENT_NAME_KEY) || [])[1] || '';
  const info = rows
    .filter(([label, value]) => label && value && label !== EVENT_NAME_KEY)
    .map(([label, value]) => ({ label, value }));
  return { members: [...members.values()], info, eventName };
}

function dataRows_(sheet) {
  return sheet.getDataRange().getValues().slice(1)
    .map(r => [String(r[0]).trim(), ...r.slice(1)])
    .filter(r => r[0]);
}

function findRow_(sheet, name) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const names = sheet.getRange(2, 1, last - 1, 1).getValues();
  const i = names.findIndex(r => String(r[0]).trim() === name);
  return i < 0 ? 0 : i + 2;
}

function callRow_(s, name) {
  requireMember_(s, name);
  let row = findRow_(s.call, name);
  if (!row) {
    s.call.appendRow([name, false]);
    row = s.call.getLastRow();
    s.call.getRange(row, 2).insertCheckboxes();
  }
  return row;
}

function requireMember_(s, name) {
  if (!findRow_(s.call, name) && !findRow_(s.attend, name)) {
    throw new Error(`「${name}」が見つかりません。画面を更新してください`);
  }
}

function newName_(s, raw, exclude) {
  const name = validName_(raw);
  if (name !== exclude && (findRow_(s.call, name) || findRow_(s.attend, name))) {
    throw new Error(`「${name}」はすでに登録されています`);
  }
  return name;
}

// 名前は「姓 名」（半角スペース区切り）で保存する
function validName_(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!/^\S+ \S+$/.test(name)) throw new Error('姓と名を入力してください');
  if (/^[=+\-@]/.test(name)) throw new Error('名前の先頭に記号は使えません');
  if (name.length > 40) throw new Error('名前が長すぎます');
  return name;
}

function class_(v) {
  const s = String(v || '');
  if (s && !CLASSES.includes(s)) throw new Error('クラスの値が不正です');
  return s;
}

function count_(v) {
  const n = Math.floor(Number(v) || 0);
  return Math.min(Math.max(n, 0), 20);
}

function status_(v) {
  const s = String(v || '');
  if (s && !STATUSES.includes(s)) throw new Error('参加可否の値が不正です');
  return s;
}

// 先頭が = などだと数式として解釈されるため、文字列として保存する
function safeText_(v, max) {
  const s = String(v || '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function formatDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'M/d H:mm') : String(v || '');
}
