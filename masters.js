// Мастера салона: кто работает, что делает и когда отдыхает.
//
// Раньше состав салона был строкой в настройках сервера (SALON_MASTERS). Чтобы
// принять человека на работу, владельцу нужно было открыть панель Render,
// поправить переменную и перезапустить сервис; выходных и специализаций там не
// было вовсе, поэтому бот с одинаковой готовностью записывал клиента на
// окрашивание к мастеру маникюра и к тому, кто в этот день в отпуске.
//
// Теперь это таблица в базе, а здесь — её кэш и вся логика «кто может взять
// клиента в такой-то день». Кэш нужен не ради скорости: расписание считается на
// каждое сообщение клиента и на каждое нажатие кнопки, и ходить за составом
// салона в базу по десять раз на одно «а когда свободно?» незачем.
//
// Отдельная забота — работать до того, как владелец выполнит
// supabase_salon_step2.sql. Между выкладкой кода и этим моментом таблиц ещё
// нет, и падать здесь нельзя: бот просто возвращается к составу из
// SALON_MASTERS и говорит владельцу, что делать.

const salon = require('./salon');
// Не деструктурируем: так подмена db в тестах видна и отсюда.
const db = require('./db');

const CACHE_TTL_MS = 60 * 1000;
const ALL_DAYS = '1,2,3,4,5,6,7';
const WEEKDAY_SHORT = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

const NEEDS_SQL =
  'Справочник мастеров ещё не создан. Выполните в Supabase скрипт supabase_salon_step2.sql — ' +
  'пока работаю по списку из настройки SALON_MASTERS.';

let cache = null;
let loading = null;
let migrated = false;

/* ---------------- дни недели и даты ---------------- */

// 1 — понедельник ... 7 — воскресенье. В JS неделя начинается с воскресенья и
// нумеруется с нуля, а владелец читает расписание с понедельника.
function isoWeekday(date) {
  const w = salon.localParts(date).weekday;
  return w === 0 ? 7 : w;
}

// «2026-08-20» по часам салона: в этом виде выходные лежат в базе.
function dayKey(date) {
  const p = salon.localParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Пусто в work_days — это «не работает ни в один день», а не «работает всегда»:
// владелец мог снять все галочки нарочно. А вот отсутствие значения (старая
// строка, добавленная мимо бота) означает обычную неделю.
function parseWorkDays(raw) {
  if (raw === null || raw === undefined) return new Set([1, 2, 3, 4, 5, 6, 7]);
  return new Set(
    String(raw)
      .split(/[^\d]+/)
      .map(Number)
      .filter((n) => n >= 1 && n <= 7)
  );
}

function workDaysText(raw) {
  const days = [...parseWorkDays(raw)].sort((a, b) => a - b);
  if (days.length === 0) return 'ни одного дня';
  if (days.length === 7) return 'каждый день';
  return days.map((d) => WEEKDAY_SHORT[d]).join(', ');
}

/* ---------------- загрузка справочника ---------------- */

function fallbackState(error) {
  return {
    masters: salon.ENV_MASTERS.map((name) => ({ id: null, name, active: true, work_days: ALL_DAYS })),
    links: [],
    daysOff: [],
    at: Date.now(),
    degraded: error ? NEEDS_SQL : null,
  };
}

async function read() {
  try {
    await migrateOnce();
    const [masters, links, daysOff] = await Promise.all([
      db.listMasters(),
      db.listMasterServices(),
      // Вчерашним днём и раньше расписание уже не управляет, а за год отгулов
      // накапливаются сотни строк.
      db.listDaysOff({ from: dayKey(salon.addDays(new Date(), -1)) }),
    ]);
    cache = { masters, links, daysOff, at: Date.now(), degraded: null };
  } catch (err) {
    console.error('Справочник мастеров недоступен:', err.message);
    cache = fallbackState(err);
  }

  // salon.js считает занятость по этому списку — и в админке, и в WhatsApp.
  salon.setMasters(cache.masters.filter((m) => m.active).map((m) => m.name));
  return cache;
}

async function load({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;

  // Одна загрузка на всех: на одно сообщение клиента состав спрашивают
  // несколько мест подряд, и пять одинаковых запросов в базу тут ни к чему.
  if (loading) {
    if (!force) return loading;
    // Владелец только что нажал кнопку — ему нужен состав после его правки,
    // а не тот, что уже летит из базы. Дожидаемся и читаем заново.
    await loading.catch(() => {});
  }

  loading = read().finally(() => { loading = null; });
  return loading;
}

/* ---------------- первый запуск ----------------
   Справочник заводится сам: из SALON_MASTERS, если он пуст, и из имён, которые
   уже стоят в старых записях. Владелец не должен вбивать мастеров заново
   только потому, что мы поменяли способ их хранения. */

async function migrateOnce() {
  if (migrated) return;

  const existing = await db.listMasters();
  if (existing.length === 0 && salon.ENV_MASTERS.length > 0) {
    for (const name of salon.ENV_MASTERS) {
      await db.addMaster({ name, active: true, workDays: ALL_DAYS });
    }
    console.log(`Мастера перенесены из SALON_MASTERS: ${salon.ENV_MASTERS.join(', ')}`);
  }

  await linkOldAppointments();
  migrated = true;
}

// Старые записи знают мастера только по имени. Связываем их со справочником,
// чтобы переименование мастера не разорвало историю.
//
// Имя из записи может не совпасть ни с кем: мастер уволился ещё до всего этого,
// или владелец писал его от руки с опечаткой. Такого мастера заводим, но сразу
// скрытым — в истории он нужен, в списке «к кому записать» нет.
async function linkOldAppointments() {
  const rows = await db.listUnlinkedAppointments();
  if (rows.length === 0) return;

  const roster = await db.listMasters();
  const byKey = new Map(roster.map((m) => [salon.masterKey(m.name), m]));

  const groups = new Map();
  for (const row of rows) {
    const key = salon.masterKey(row.master);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { name: String(row.master).trim(), ids: [] });
    groups.get(key).ids.push(row.id);
  }

  for (const [key, group] of groups) {
    let master = byKey.get(key);
    if (!master) {
      // «Динаре» в записи и «Динара» в справочнике — один человек. Ищем так же,
      // как имя мастера в живой речи клиента.
      const matchedName = salon.matchMaster(group.name, roster.map((m) => m.name));
      master = matchedName ? roster.find((m) => m.name === matchedName) : null;
    }
    if (!master) {
      master = await db.addMaster({ name: group.name, active: false, workDays: ALL_DAYS });
      roster.push(master);
      byKey.set(salon.masterKey(master.name), master);
      console.log(`Мастер «${group.name}» встречался в записях, но в салоне не заведён — добавил скрытым.`);
    }
    await db.linkAppointments(group.ids, master.id);
  }

  console.log(`Записей связано с мастерами: ${rows.length}.`);
}

/* ---------------- кто работает ---------------- */

function isDayOff(master, day, state) {
  const key = dayKey(day);
  return state.daysOff.some(
    (o) => String(o.master_id) === String(master.id) && String(o.day).slice(0, 10) === key
  );
}

function worksOn(master, day, state) {
  if (!master.active) return false;
  if (!parseWorkDays(master.work_days).has(isoWeekday(day))) return false;
  return !isDayOff(master, day, state);
}

// Кто может взять клиента в этот день (и, если услуга известна, на эту услугу).
//
// Возвращает:
//   names      — имена для расчёта занятости;
//   configured — мастера в салоне вообще заведены;
//   dayOff     — заведены, но в этот день не работает никто (общий выходной);
//   noService  — работают, но никто из них не делает эту услугу.
async function staffOn(day, { serviceId } = {}) {
  const state = await load();
  const active = state.masters.filter((m) => m.active);
  const working = active.filter((m) => worksOn(m, day, state));

  let rows = working;
  if (serviceId !== undefined && serviceId !== null) {
    const doers = new Set(
      state.links
        .filter((l) => String(l.service_id) === String(serviceId))
        .map((l) => String(l.master_id))
    );
    // Никого не отметили — услугу делают все. Салон, который ещё не расписал,
    // кто что умеет, не должен из-за этого перестать записывать клиентов.
    if (doers.size > 0) rows = working.filter((m) => doers.has(String(m.id)));
  }

  return {
    names: rows.map((m) => m.name),
    rows,
    configured: active.length > 0,
    dayOff: active.length > 0 && working.length === 0,
    noService: working.length > 0 && rows.length === 0,
    degraded: state.degraded,
  };
}

/* ---------------- справки для экранов ---------------- */

async function all() {
  return (await load()).masters;
}

async function activeRows() {
  return (await load()).masters.filter((m) => m.active);
}

async function names() {
  return (await activeRows()).map((m) => m.name);
}

async function get(id) {
  return (await load()).masters.find((m) => String(m.id) === String(id)) || null;
}

// Мастер по имени — нужен, чтобы новая запись легла со ссылкой на справочник,
// а не только с именем строкой.
async function byName(name) {
  if (!name) return null;
  const state = await load();
  const key = salon.masterKey(name);
  return state.masters.find((m) => salon.masterKey(m.name) === key) || null;
}

async function idByName(name) {
  const master = await byName(name);
  return master && master.id != null ? master.id : undefined;
}

async function serviceIdsOf(id) {
  const state = await load();
  return state.links.filter((l) => String(l.master_id) === String(id)).map((l) => Number(l.service_id));
}

async function daysOffOf(id) {
  const state = await load();
  return state.daysOff
    .filter((o) => String(o.master_id) === String(id))
    .map((o) => String(o.day).slice(0, 10))
    .sort();
}

// Снимок без обращения к базе — для эндпоинта здоровья: ходить в Supabase
// ради ответа «жив ли сервис» незачем, а видеть состав салона снаружи полезно.
function snapshot() {
  if (!cache) return { loaded: false };
  return {
    loaded: true,
    active: cache.masters.filter((m) => m.active).map((m) => m.name),
    hidden: cache.masters.filter((m) => !m.active).length,
    ...(cache.degraded ? { warning: cache.degraded } : {}),
  };
}

async function status() {
  const state = await load();
  return {
    degraded: state.degraded,
    count: state.masters.filter((m) => m.active).length,
    hidden: state.masters.filter((m) => !m.active).length,
  };
}

/* ---------------- изменения ----------------
   Каждое правит базу и тут же перечитывает состав: владелец нажимает кнопку и
   в том же экране должен увидеть результат, а не вчерашний кэш. */

async function add(name) {
  const master = await db.addMaster({ name, active: true, workDays: ALL_DAYS });
  await load({ force: true });
  return master;
}

async function rename(id, name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Пустое имя');
  const master = await db.updateMaster(id, { name: clean });
  await load({ force: true });
  return master;
}

// Уволился — прячем, не удаляем: его имя стоит в прошлых записях, и удаление
// стёрло бы историю клиента.
async function setActive(id, active) {
  const master = await db.updateMaster(id, { active });
  await load({ force: true });
  return master;
}

async function toggleWorkDay(id, weekday) {
  const master = await get(id);
  if (!master) return null;
  const days = parseWorkDays(master.work_days);
  if (days.has(weekday)) days.delete(weekday);
  else days.add(weekday);
  const updated = await db.updateMaster(id, {
    work_days: [...days].sort((a, b) => a - b).join(','),
  });
  await load({ force: true });
  return updated;
}

async function toggleService(id, serviceId) {
  const current = await serviceIdsOf(id);
  await db.setMasterService(id, serviceId, !current.includes(Number(serviceId)));
  await load({ force: true });
}

async function toggleDayOff(id, day) {
  const key = typeof day === 'string' ? day : dayKey(day);
  const current = await daysOffOf(id);
  await db.setDayOff(id, key, !current.includes(key));
  await load({ force: true });
}

module.exports = {
  ALL_DAYS,
  WEEKDAY_SHORT,
  NEEDS_SQL,
  load,
  staffOn,
  all,
  activeRows,
  names,
  get,
  byName,
  idByName,
  serviceIdsOf,
  daysOffOf,
  snapshot,
  status,
  add,
  rename,
  setActive,
  toggleWorkDay,
  toggleService,
  toggleDayOff,
  dayKey,
  isoWeekday,
  parseWorkDays,
  workDaysText,
};
