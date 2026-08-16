// Напоминания клиентам о записи.
//
// Забытая запись стоит салону дороже всего остального: кресло стоит пустым,
// мастер ждёт, а клиент вспоминает о визите вечером. Поэтому бот сам пишет
// клиенту накануне в 19:00, а если запись сделали позже этого часа — за два
// часа до начала.
//
// Три вещи, из-за которых это не сводится к одному setInterval.
//
// 1. Отметка «напомнили» лежит в базе (колонка reminded_at). Бесплатный Render
//    перезапускает сервис по нескольку раз в сутки: держи мы её в памяти,
//    после каждого перезапуска клиент получал бы напоминание заново, и номер
//    салона довольно быстро заблокировали бы за спам.
// 2. Уснувший сервис ничего не отправляет. Free-тариф засыпает через ~15 минут
//    без входящих запросов, поэтому таймер здесь — только половина дела: будит
//    сервис внешний будильник (см. /cron в server.js). Проснувшись, бот
//    догоняет всё, что пропустил, — но не ночью: см. ниже.
// 3. Ночью не пишем. Разбудить клиента в три часа сообщением «напоминаю о
//    записи» — худшее, что может сделать вежливый бот.
//
// Клиенту, который записывался не через WhatsApp (владелец завёл запись сам,
// чата с ним нет), написать нельзя: сообщение первым незнакомому номеру
// WhatsApp считает спамом. Такому клиенту напоминание уходит владельцу —
// «позвоните».

const salon = require('./salon');
// Не деструктурируем: так подмена db и notify в тестах видна и отсюда.
const db = require('./db');
const notify = require('./notify');

const SALON_ADDRESS = process.env.SALON_ADDRESS || process.env.SHOP_ADDRESS || '';

// Час накануне, в который уходит напоминание. Девятнадцать — время, когда
// человек уже не на работе, но ещё не спит, и успевает отменить запись, если
// планы поменялись: салону останется ночь и утро, чтобы отдать окошко другому.
const EVENING_HOUR = Number(process.env.SALON_REMINDER_HOUR || 19);

// За сколько напоминать, если вечер накануне уже прошёл в момент записи.
const LATE_LEAD_MINUTES = Number(process.env.SALON_REMINDER_LEAD_MINUTES || 120);

// Запись, сделанную меньше чем за столько до начала, не напоминаем вовсе:
// клиент договорился только что и помнит об этом лучше нас.
const FRESH_BOOKING_MINUTES = 180;

// Ближе этого к началу напоминание бессмысленно: клиент либо уже в дороге,
// либо всё равно не успеет.
const MIN_LEAD_MINUTES = 20;

// Ночная тишина по часам салона. Всё, что стало «пора» ночью, ждёт утра.
const QUIET_FROM = 22 * 60;
const QUIET_TO = 8 * 60;

const TICK_MS = 5 * 60 * 1000;
// Проверять записи дальше полутора суток незачем: раньше вечера накануне
// напоминание всё равно не уйдёт.
const HORIZON_MS = 36 * 60 * 60 * 1000;

// Внешний будильник может стучаться часто — на каждый стук в базу не ходим.
const MIN_GAP_MS = 60 * 1000;

const NEEDS_SQL =
  'Напоминания клиентам выключены: в таблице записей нет колонки reminded_at. ' +
  'Выполните в Supabase скрипт supabase_salon_step3.sql.';

const state = {
  ready: null,
  warning: null,
  lastRunAt: null,
  last: null,
  running: false,
};

let timer = null;
let warnedNoSql = false;
let warnedOffline = false;

/* ---------------- когда напоминать ---------------- */

// Момент, в который клиенту пора написать.
//
// Обычный случай — вечер накануне. Но запись могли сделать и позже этого
// вечера («завтра в десять?» в половине девятого): напоминать задним числом
// нечего, поэтому такой записи считаем два часа до начала.
function dueAt(appointment) {
  const start = new Date(appointment.starts_at);
  const evening = salon.atLocalTime(salon.addDays(start, -1), EVENING_HOUR * 60);
  const created = appointment.created_at ? new Date(appointment.created_at) : null;

  if (!created || evening.getTime() >= created.getTime()) return evening;
  return new Date(start.getTime() - LATE_LEAD_MINUTES * 60 * 1000);
}

// Запись сделана впритык — напоминать не о чем.
function bookedJustNow(appointment) {
  if (!appointment.created_at) return false;
  const start = new Date(appointment.starts_at).getTime();
  const created = new Date(appointment.created_at).getTime();
  return start - created < FRESH_BOOKING_MINUTES * 60 * 1000;
}

function isQuietHour(now) {
  const minutes = salon.localMinutes(now);
  return minutes >= QUIET_FROM || minutes < QUIET_TO;
}

// Что делать с записью прямо сейчас: 'send' — пора, 'wait' — ещё рано или
// ночь, 'skip' — напоминание уже не нужно.
function decide(appointment, now = new Date()) {
  const start = new Date(appointment.starts_at).getTime();
  const minutesLeft = (start - now.getTime()) / 60000;

  if (minutesLeft < MIN_LEAD_MINUTES) return 'skip';
  if (bookedJustNow(appointment)) return 'skip';
  if (now.getTime() < dueAt(appointment).getTime()) return 'wait';
  if (isQuietHour(now)) return 'wait';
  return 'send';
}

/* ---------------- тексты ---------------- */

function clientText(appointment) {
  const when = salon.formatWhen(new Date(appointment.starts_at));
  const what = [appointment.service, appointment.master ? `мастер ${appointment.master}` : null]
    .filter(Boolean)
    .join(', ');

  const lines = [
    `Здравствуйте, ${appointment.client_name}! Напоминаю о записи: ${when}` +
      `${what ? ` — ${what}` : ''}.`,
  ];
  if (SALON_ADDRESS) lines.push(`Адрес: ${SALON_ADDRESS}`);
  lines.push('Если планы изменились — напишите, перенесём или отменим.');
  return lines.join('\n');
}

// Владельцу — с телефоном и кнопками: он читает это на ходу, и «позвоните»
// без номера под рукой ничего не решает.
function ownerText(appointment, head) {
  const lines = [
    head,
    '',
    `${appointment.client_name} — ${salon.formatWhen(new Date(appointment.starts_at))}`,
  ];
  if (appointment.service) lines.push(`Услуга: ${appointment.service}`);
  if (appointment.master) lines.push(`Мастер: ${appointment.master}`);
  lines.push(appointment.phone ? `Телефон: +${appointment.phone}` : 'Телефона нет — только имя.');
  return lines.join('\n');
}

function ownerButtons(appointment) {
  return [
    [{ text: '✅ Позвонил', callback_data: `n_called:${appointment.id}` }],
    [{ text: '❌ Отменить запись', callback_data: `appt_cancel:${appointment.id}` }],
  ];
}

/* ---------------- отправка ----------------
   WhatsApp-часть подключаем по требованию, а не наверху файла: напоминания
   должны работать и тогда, когда WhatsApp ещё не поднялся (или упал). */

function whatsapp() {
  try {
    return require('./index');
  } catch (err) {
    console.error('WhatsApp-часть недоступна:', err.message);
    return null;
  }
}

function whatsappOnline() {
  const wa = whatsapp();
  try {
    return Boolean(wa) && wa.getStatus().connection === 'open';
  } catch {
    return false;
  }
}

async function sendToClient(appointment) {
  const wa = whatsapp();
  if (!wa) return false;
  try {
    return await wa.sendToClient(appointment.chat_id, clientText(appointment));
  } catch (err) {
    console.error('Не удалось напомнить клиенту в WhatsApp:', err.message);
    return false;
  }
}

async function tellOwner(appointment, head) {
  try {
    await notify.notifyAdmins(ownerText(appointment, head), { buttons: ownerButtons(appointment) });
  } catch (err) {
    console.error('Не удалось передать напоминание владельцу:', err.message);
  }
}

/* ---------------- проход по записям ---------------- */

async function tick({ now = new Date(), force = false } = {}) {
  if (state.running) return { skipped: 'уже идёт' };
  if (!force && state.lastRunAt && now.getTime() - state.lastRunAt.getTime() < MIN_GAP_MS) {
    return { skipped: 'только что' };
  }

  state.running = true;
  const result = { checked: 0, sent: 0, toOwner: 0, waiting: 0 };

  try {
    state.ready = await db.remindersReady();
    if (!state.ready) {
      state.warning = NEEDS_SQL;
      if (!warnedNoSql) {
        warnedNoSql = true;
        console.error(NEEDS_SQL);
      }
      return { ...result, enabled: false };
    }
    state.warning = null;

    const rows = await db.listDueReminders({ from: now, to: new Date(now.getTime() + HORIZON_MS) });
    result.checked = rows.length;

    // Связь с WhatsApp проверяем один раз на проход: если её нет, писать
    // некому — но отметку «напомнили» ставить нельзя, иначе клиент не получит
    // напоминания вовсе. Такие записи просто ждут следующего прохода.
    const online = whatsappOnline();
    if (!online && !warnedOffline) {
      warnedOffline = true;
      console.error('WhatsApp не на связи — напоминания клиентам подождут связи.');
    }
    if (online) warnedOffline = false;

    for (const appointment of rows) {
      const verdict = decide(appointment, now);
      if (verdict === 'skip') continue;
      if (verdict === 'wait') {
        result.waiting += 1;
        continue;
      }

      // Ошибка на одной записи не должна оставить без напоминания весь день:
      // разбираемся с каждой отдельно.
      try {
        if (appointment.chat_id) {
          if (!online) {
            result.waiting += 1;
            continue;
          }
          if (await sendToClient(appointment)) {
            await db.markReminded(appointment.id, now);
            result.sent += 1;
            continue;
          }
          // Чат есть, а сообщение не дошло: клиент мог заблокировать бота или
          // сменить номер. Молчать нельзя — пусть владелец позвонит.
          await tellOwner(appointment, '⚠️ Не смог напомнить клиенту в WhatsApp — позвоните.');
          await db.markReminded(appointment.id, now);
          result.toOwner += 1;
          continue;
        }

        await tellOwner(appointment, '📞 Позвоните клиенту — он записывался не через WhatsApp.');
        await db.markReminded(appointment.id, now);
        result.toOwner += 1;
      } catch (err) {
        console.error(`Напоминание по записи #${appointment.id} не прошло:`, err.message);
      }
    }

    return { ...result, enabled: true };
  } catch (err) {
    console.error('Напоминания: проход не удался:', err.message);
    return { ...result, error: err.message };
  } finally {
    state.running = false;
    state.lastRunAt = now;
    state.last = result;
  }
}

async function run(reason) {
  const result = await tick();
  // В лог пишем только когда что-то произошло: проход раз в пять минут круглые
  // сутки — это триста одинаковых строк в день, среди которых не видно ничего.
  if (result.sent > 0 || result.toOwner > 0) {
    console.log(
      `Напоминания (${reason}): клиентам ${result.sent}, владельцу ${result.toOwner}, ` +
        `проверено ${result.checked}.`
    );
  }
  return result;
}

// Таймер — половина дела: уснувший сервис не тикает. Вторая половина — внешний
// будильник, который стучится на /cron и будит сервис (см. server.js).
// Поэтому первый проход делаем вскоре после старта: если сервис проспал вечер,
// напоминания уйдут сразу после пробуждения.
function start({ delayMs = 20 * 1000 } = {}) {
  if (timer) return timer;

  setTimeout(() => run('старт').catch((err) => console.error('Напоминания:', err.message)), delayMs).unref();
  timer = setInterval(
    () => run('таймер').catch((err) => console.error('Напоминания:', err.message)),
    TICK_MS
  );
  timer.unref();
  console.log(`Напоминания включены: проверка каждые ${TICK_MS / 60000} мин.`);
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Для health-эндпоинта и экрана записей: почему напоминаний нет, видно снаружи.
function status() {
  return {
    enabled: state.ready !== false,
    ...(state.warning ? { warning: state.warning } : {}),
    lastRunAt: state.lastRunAt ? state.lastRunAt.toISOString() : null,
    last: state.last,
  };
}

function warning() {
  return state.warning;
}

module.exports = {
  EVENING_HOUR,
  LATE_LEAD_MINUTES,
  MIN_LEAD_MINUTES,
  FRESH_BOOKING_MINUTES,
  NEEDS_SQL,
  dueAt,
  decide,
  isQuietHour,
  clientText,
  ownerText,
  tick,
  run,
  start,
  stop,
  status,
  warning,
};
