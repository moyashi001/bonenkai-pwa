// 忘年会 参加管理 - Google Apps Script
// スプレッドシートの「拡張機能 > Apps Script」に貼り付けて使う

const SHEET_CALL = '声掛け';
const SHEET_ATTEND = '参加管理';
const SHEET_INFO = '開催情報';
const CALL_HEADER = ['名前', '声掛け済み', '声をかけた人', '更新日時'];
const ATTEND_HEADER = ['名前', '一次会', '二次会', '備考', '更新日時'];
const INFO_KEYS = ['日時', '場所', '会費', '回答期限', '二次会の場所'];
const STATUSES = ['参加', '不参加', '未定'];
const NAME_RE = /^[ぁ-ゖー]+(（[^（）]+）)?$/;
const TZ = 'Asia/Tokyo';

// 初回に1度だけ GAS エディタから実行する
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_CALL, CALL_HEADER);
  const attend = ensureSheet_(ss, SHEET_ATTEND, ATTEND_HEADER);
  const info = ensureSheet_(ss, SHEET_INFO, ['項目', '内容']);
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
    try {
      action(sheets_(), req);
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }
    return readState_();
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
    const name = newName_(s, req.name);
    s.call.appendRow([name, false, '', '']);
    s.call.getRange(s.call.getLastRow(), 2).insertCheckboxes();
    s.attend.appendRow([name, '', '', '', '']);
  },

  rename(s, req) {
    const oldName = String(req.oldName);
    requireMember_(s, oldName);
    const name = newName_(s, req.newName, oldName);
    [s.call, s.attend].forEach(sheet => {
      const row = findRow_(sheet, oldName);
      if (row) sheet.getRange(row, 1).setValue(name);
    });
    // 「声をかけた人」に書かれた旧名も新しい名前にそろえる
    const last = s.call.getLastRow();
    if (last >= 2) {
      const range = s.call.getRange(2, 3, last - 1, 1);
      range.setValues(range.getValues().map(([c]) => [String(c) === oldName ? name : c]));
    }
  },

  remove(s, req) {
    [s.call, s.attend].forEach(sheet => {
      const row = findRow_(sheet, String(req.name));
      if (row) sheet.deleteRow(row);
    });
  },

  call(s, req) {
    const caller = safeText_(req.caller, 50);
    if (!caller) throw new Error('声をかけた人を選んでください');
    const row = callRow_(s, String(req.name));
    s.call.getRange(row, 2, 1, 3).setValues([[true, caller, new Date()]]);
  },

  uncall(s, req) {
    const row = callRow_(s, String(req.name));
    s.call.getRange(row, 2, 1, 3).setValues([[false, '', new Date()]]);
  },

  attend(s, req) {
    const name = String(req.name);
    requireMember_(s, name);
    const values = [status_(req.first), status_(req.second), safeText_(req.note, 200), new Date()];
    let row = findRow_(s.attend, name);
    if (!row) {
      s.attend.appendRow([name]);
      row = s.attend.getLastRow();
    }
    s.attend.getRange(row, 2, 1, 4).setValues([values]);
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
  return s;
}

function readState_() {
  const s = sheets_();
  const members = new Map();
  const member = name => {
    if (!members.has(name)) {
      members.set(name, {
        name, called: false, caller: '', calledAt: '',
        first: '', second: '', note: '', updatedAt: '',
      });
    }
    return members.get(name);
  };
  dataRows_(s.call).forEach(r => {
    const m = member(r[0]);
    m.called = r[1] === true;
    m.caller = String(r[2]);
    m.calledAt = r[1] === true ? formatDate_(r[3]) : '';
  });
  dataRows_(s.attend).forEach(r => {
    const m = member(r[0]);
    m.first = String(r[1]);
    m.second = String(r[2]);
    m.note = String(r[3]);
    m.updatedAt = formatDate_(r[4]);
  });
  const info = s.info.getDataRange().getDisplayValues().slice(1)
    .filter(([label, value]) => label && value)
    .map(([label, value]) => ({ label, value }));
  return { members: [...members.values()], info };
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
  const name = normalizeName_(raw);
  if (!NAME_RE.test(name)) throw new Error('名前はひらがなで入力してください');
  if (name !== exclude && (findRow_(s.call, name) || findRow_(s.attend, name))) {
    throw new Error(`「${name}」はすでに登録されています`);
  }
  return name;
}

function normalizeName_(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\(/g, '（')
    .replace(/\)/g, '）');
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
