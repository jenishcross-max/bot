// Салон красоты / парикмахерская: время, мастера и разбор просьбы записаться.
//
// Клиенту здесь нужен не предмет, а час в кресле. Поэтому всё в этом файле про
// время: «завтра в три» -> конкретный момент, сетка свободных окошек, занятость
// мастера. Считает это один код на всех — и бота в WhatsApp, и админку в
// Телеграме: разойдись два расчёта, владелец пообещает по телефону время,
// которое бот в этот же момент отдал другому.
//
// Услуги лежат в таблице products (имя досталось от прежней версии): название,
// цена и длительность.

const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Часовой пояс салона. Сервер на Render живёт по UTC, а «сегодня в 14:00» клиент
// говорит по своим часам: без пояса запись уезжает на шесть часов назад.
const TIMEZONE = process.env.SALON_TZ || 'Asia/Bishkek';

// Два разных числа, которые раньше были одним и тем же.
//
// SLOT_MINUTES — сколько длится услуга, у которой длительность не проставлена.
// SLOT_STEP — как часто мы вообще предлагаем время: 09:00, 09:30, 10:00...
//
// Пока это было одно число, стрижка на сорок минут съедала час, а окраска на
// три часа занимала один — и бот предлагал клиенту время, когда мастер ещё
// работал с предыдущим.
const SLOT_MINUTES = Number(process.env.SALON_SLOT_MINUTES || 60);
const SLOT_STEP = Number(process.env.SALON_SLOT_STEP || 30);

// Сколько занимает конкретная запись. У старых записей колонки нет вовсе —
// считаем их обычными по длительности.
function appointmentDuration(a) {
  const raw = Number(a?.duration_minutes);
  return Number.isFinite(raw) && raw > 0 ? raw : SLOT_MINUTES;
}
const MASTERS = (process.env.SALON_MASTERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// За сколько минут до начала окошко перестаёт быть свободным. Предлагать
// клиенту «через пять минут» бессмысленно: он не успеет доехать, а мастер
// будет ждать. Полчаса — разумный минимум, меняется переменной.
const LEAD_MINUTES = Number(process.env.SALON_LEAD_MINUTES || 30);

// Часы работы берём из SALON_HOURS, а если их нет — из общих SHOP_HOURS, где
// время написано вперемешку с днями недели («Пн-Вс, 09:00-21:00»).
function parseHours(raw) {
  const m = /(\d{1,2}):(\d{2})\D+(\d{1,2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return { open: 9 * 60, close: 20 * 60 };
  return {
    open: Number(m[1]) * 60 + Number(m[2]),
    close: Number(m[3]) * 60 + Number(m[4]),
  };
}

const WORK_HOURS = parseHours(process.env.SALON_HOURS || process.env.SHOP_HOURS);

/* ---------------- время ---------------- */

const partsFmt = new Intl.DateTimeFormat('ru-RU', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Дата и время по часам салона, а не по часам сервера.
function localParts(date = new Date()) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  // День недели считаем от «местных» чисел, иначе около полуночи он берётся от
  // серверной даты и съезжает на сутки.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, hour, minute, weekday };
}

// На сколько местное время впереди UTC в этот момент.
function tzOffsetMs(date) {
  const p = localParts(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Секунды отбрасываем: иначе смещение «дрожит» на неполную минуту.
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

const pad = (n) => String(n).padStart(2, '0');

// «2026-08-16T15:00» по часам салона -> момент времени. Именно так модель
// возвращает дату: без пояса, как её произносит клиент.
function localIsoToDate(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(String(iso || '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const date = new Date(guess - tzOffsetMs(new Date(guess)));
  return Number.isNaN(date.getTime()) ? null : date;
}

function localIso(date = new Date()) {
  const p = localParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

// Начало и конец местных суток как моменты времени — для выборки «записи на сегодня».
function localDayRange(date = new Date()) {
  const p = localParts(date);
  const startIso = `${p.year}-${pad(p.month)}-${pad(p.day)}T00:00`;
  const from = localIsoToDate(startIso);
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

function sameLocalDay(a, b) {
  const x = localParts(a);
  const y = localParts(b);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

function formatTime(date) {
  const p = localParts(date);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function formatDay(date) {
  const p = localParts(date);
  return `${p.day} ${MONTHS[p.month - 1]}, ${WEEKDAYS[p.weekday]}`;
}

// «сегодня в 14:00» читается лучше, чем «16.08.2026 14:00», и клиенту, и владельцу.
function formatWhen(date, now = new Date()) {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (sameLocalDay(date, now)) return `сегодня в ${formatTime(date)}`;
  if (sameLocalDay(date, tomorrow)) return `завтра в ${formatTime(date)}`;
  const p = localParts(date);
  return `${p.day} ${MONTHS[p.month - 1]} в ${formatTime(date)}`;
}

// «сегодня» / «завтра» / «суббота, 22 августа» — заголовок списка окошек.
function dayLabel(date, now = new Date()) {
  if (sameLocalDay(date, now)) return 'сегодня';
  if (sameLocalDay(date, new Date(now.getTime() + 24 * 60 * 60 * 1000))) return 'завтра';
  const p = localParts(date);
  return `${WEEKDAYS[p.weekday]}, ${p.day} ${MONTHS[p.month - 1]}`;
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// Минуты от полуночи по часам салона — в них удобно считать сетку дня.
function localMinutes(date) {
  const p = localParts(date);
  return p.hour * 60 + p.minute;
}

// Обратно: день + минуты от полуночи -> момент времени.
function atLocalTime(day, minutes) {
  const p = localParts(day);
  const h = Math.floor(minutes / 60);
  return localIsoToDate(`${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(h)}:${pad(minutes % 60)}`);
}

// Сколько суток между сегодня и днём (по местным датам, а не по 24 часам).
function dayOffset(day, now = new Date()) {
  const a = localDayRange(now).from.getTime();
  const b = localDayRange(day).from.getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

const WEEKDAY_PATTERNS = [
  [/воскресень/i, 0],
  [/понедельник/i, 1],
  [/вторник/i, 2],
  [/сред[ауеы]/i, 3],
  [/четверг/i, 4],
  [/пятниц/i, 5],
  [/суббот/i, 6],
];

// День из фразы клиента, без обращения к модели.
//
// Нужен для вопроса о свободном времени: часа там нет, и модель на «есть окошки
// завтра?» устойчиво возвращает пустую дату — день для неё не выглядит частью
// записи. В итоге на вопрос про завтра бот показывал сегодняшнее расписание.
// Такие слова разбираются кодом надёжнее, чем моделью.
function dayFromText(text, now = new Date()) {
  const s = String(text || '');
  // «послезавтра» проверяем первым: внутри него есть «завтра».
  if (/послезавтра/i.test(s)) return addDays(now, 2);
  if (/завтра/i.test(s)) return addDays(now, 1);
  if (/сегодня/i.test(s)) return now;

  for (const [re, weekday] of WEEKDAY_PATTERNS) {
    if (!re.test(s)) continue;
    // Ближайший такой день недели, считая сегодняшний.
    return addDays(now, (weekday - localParts(now).weekday + 7) % 7);
  }
  return null;
}

/* ---------------- мастера ----------------
   Имя мастера приходит из живой речи: «к Динаре», «запиши к Азамату», «у Айгуль».
   Сравнение строка-в-строку такое имя не узнаёт, и мастер молча терялся — запись
   создавалась «без мастера», хотя владелец его назвал. */

function masterKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я]/g, '');
}

// Слова, которые стоят рядом с именем и именем не являются. Без них «к Динаре»
// склеивается в «кдинаре» и не совпадает ни с чем.
const NOT_A_NAME = new Set([
  'к', 'ко', 'у', 'на', 'до', 'от', 'с', 'со', 'в', 'во', 'для', 'же', 'бы',
  'мастер', 'мастеру', 'мастера', 'мастером', 'мастерша',
]);

function masterTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я]+/)
    .filter((t) => t.length > 1 && !NOT_A_NAME.has(t));
}

// Русское окончание — это чаще всего один последний гласный или мягкий знак:
// «Динара»/«Динаре» -> «динар», «Азамату» -> «азамат».
function masterStem(name) {
  const key = masterKey(name);
  return key.length > 4 && /[аеиоуыэюяьй]$/.test(key) ? key.slice(0, -1) : key;
}

// Ищет мастера из списка салона по имени в любой форме. Возвращает имя так, как
// оно записано в настройках, — в базе должно лежать одно написание, иначе один
// мастер превратится в трёх («Динара», «Динаре», «динара»).
function matchMaster(name, masters = MASTERS) {
  const tokens = masterTokens(name);
  if (tokens.length === 0) return null;

  // Сначала точное совпадение по любому слову: если имя названо как есть, оно
  // должно выиграть у похожего по основе соседа (Мария рядом с Мариной).
  for (const token of tokens) {
    const exact = masters.find((m) => masterKey(m) === token);
    if (exact) return exact;
  }

  for (const token of tokens) {
    const stem = masterStem(token);
    const byStem = masters.find((m) => masterStem(m) === stem);
    if (byStem) return byStem;

    // «Азаматом», «Айгулькой» — окончание длиннее одной буквы. Такое принимаем
    // только у длинных имён: у коротких так недолго спутать Марию с Мариной.
    const byPrefix = masters.find((m) => {
      const other = masterStem(m);
      const [short, long] = other.length < stem.length ? [other, stem] : [stem, other];
      return short.length >= 5 && long.length - short.length <= 2 && long.startsWith(short);
    });
    if (byPrefix) return byPrefix;
  }

  return null;
}

/* ---------------- свободные окошки ----------------
   Клиент спрашивает «а когда у вас свободно?» чаще, чем называет время сам.
   Раньше на такой вопрос отвечала модель — то есть выдумывала часы, которых
   никто не проверял. Считаем их из расписания: сетка рабочего дня минус то,
   что уже занято. */

// Сетка времени салона на конкретный день: 09:00, 09:30, 10:00 ... до закрытия.
// duration — сколько займёт услуга, которую в это окошко хотят поставить: до
// закрытия она должна успеть закончиться, поэтому окраска на три часа исчезает
// из вечера сама собой, а стрижка на сорок минут в том же вечере остаётся.
function daySlots(day, { duration = SLOT_MINUTES } = {}) {
  const out = [];
  for (let m = WORK_HOURS.open; m + duration <= WORK_HOURS.close; m += SLOT_STEP) {
    const at = atLocalTime(day, m);
    if (at) out.push(at);
  }
  return out;
}

// Занятость конкретного момента. busy — активные записи этого дня из базы.
// Возвращает { free, masters, taken }: можно ли записать, кто свободен и какие
// записи мешают (последнее нужно владельцу — ему важно имя, а не только факт).
//
// Мастера могут быть не заведены вовсе (SALON_MASTERS пуст) — тогда кресло одно
// и любая запись занимает время целиком. Если мастера есть, занятым считается
// не время, а конкретный мастер: салон в четыре руки работает параллельно, и
// «занято» для всего салона отдало бы второму клиенту отказ на пустом месте.
function availabilityAt(when, busy = [], { masters = MASTERS, duration = SLOT_MINUTES } = {}) {
  const start = new Date(when).getTime();
  const end = start + duration * 60 * 1000;

  // Пересечение двух отрезков, а не «сколько минут между началами»: запись на
  // окраску с 12:00 занимает и 13:00, и 14:00, хотя начинается один раз.
  const taken = busy.filter((a) => {
    const from = new Date(a.starts_at).getTime();
    const to = from + appointmentDuration(a) * 60 * 1000;
    return from < end && to > start;
  });

  if (masters.length === 0) {
    return { free: taken.length === 0, masters: [], taken };
  }

  const busyNames = new Set(taken.map((a) => a.master).filter(Boolean));
  let free = masters.filter((m) => !busyNames.has(m));
  // Запись без мастера («просто подстригите») занимает любое свободное кресло:
  // остаток уменьшает, но не говорит, чьё именно кресло занято.
  const floating = taken.filter((a) => !a.master).length;
  if (floating > 0) free = free.slice(0, Math.max(0, free.length - floating));

  return { free: free.length > 0, masters: free, taken };
}

// Свободное время дня — та же проверка, прогнанная по сетке рабочего дня.
function freeSlots(day, busy = [], { now = new Date(), masters = MASTERS, duration = SLOT_MINUTES } = {}) {
  const notBefore = now.getTime() + LEAD_MINUTES * 60 * 1000;

  return daySlots(day, { duration })
    .filter((at) => at.getTime() >= notBefore)
    .map((at) => ({ at, ...availabilityAt(at, busy, { masters, duration }) }))
    .filter((s) => s.free);
}

// Строки списка. Клиенту мастеров подписываем только там, где свободны не все:
// «11:00 — Динара, Айгуль» рядом с «11:00» ничего не добавляет, а читать мешает.
// Владельцу наоборот — ему важно видеть, кто именно свободен, поэтому в админке
// вызываем с withMasters.
// Несколько окошек, растянутых на весь день, вместо первых подряд. С шагом в
// полчаса первые восемь окошек — это 09:00…12:30: клиент видит стену почти
// одинаковых цифр и ни одного времени после обеда, хотя день свободен весь.
function spreadSlots(slots, limit) {
  if (slots.length <= limit) return slots;
  const step = (slots.length - 1) / (limit - 1);
  const picked = [];
  for (let i = 0; i < limit; i += 1) picked.push(slots[Math.round(i * step)]);
  return [...new Set(picked)];
}

function slotLines(slots, { masters = MASTERS, limit = 8, withMasters = false, spread = false } = {}) {
  const shown = spread ? spreadSlots(slots, limit) : slots.slice(0, limit);
  return shown.map((s) => {
    const time = formatTime(s.at);
    if (masters.length === 0) return time;
    if (!withMasters && s.masters.length === masters.length) return time;
    return `${time} — ${s.masters.join(', ')}`;
  });
}

/* ---------------- проверка времени записи ---------------- */

const MAX_AHEAD_DAYS = 120;

// Модель иногда возвращает правдоподобную чушь: прошлый год, три часа ночи,
// дату через десять лет. Пускать такое в базу нельзя — записи не должно быть
// вообще, чем должна быть неверная.
function checkWhen(date, now = new Date(), { duration = SLOT_MINUTES } = {}) {
  if (!date) return { ok: false, reason: 'no_time' };
  if (date.getTime() < now.getTime() - 60 * 1000) return { ok: false, reason: 'past' };
  if (date.getTime() > now.getTime() + MAX_AHEAD_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, reason: 'too_far' };
  }
  const p = localParts(date);
  const minutes = p.hour * 60 + p.minute;
  // Ровно полночь — это не время записи, а «клиент назвал только день»: на
  // «запишите на послезавтра» модель ставит 00:00. Спрашивать надо время,
  // а не сообщать, что мы в этот час закрыты.
  if (minutes === 0) return { ok: false, reason: 'no_clock' };
  if (minutes < WORK_HOURS.open || minutes >= WORK_HOURS.close) {
    return { ok: false, reason: 'closed' };
  }
  // Начать до закрытия мало — надо успеть закончить. Окраска на три часа в
  // 18:30 не «свободное окошко», а мастер, который уйдёт домой в девять.
  if (minutes + duration > WORK_HOURS.close) {
    return { ok: false, reason: 'no_time_left' };
  }
  return { ok: true };
}

function workHoursText() {
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  return `${fmt(WORK_HOURS.open)}–${fmt(WORK_HOURS.close)}`;
}

/* ---------------- разбор просьбы записаться ---------------- */

// Дешёвый фильтр перед обращением к модели: гонять каждое «сколько стоит стрижка»
// через второй запрос к ИИ незачем — это лишняя секунда ожидания и лишние токены.
const BOOKING_INTENT =
  /(запиш|записа|запис|свободн|окошк|окно|во сколько|когда можно|когда удобно|можно (на|в|к)|приду|подойду|подъеду|отмен|перенес|перезапиш|время есть|есть время|есть места|места есть)/i;

// Дни недели и «завтра». Клиент часто не пишет слова «записаться» вовсе:
// «а можно завтра в три к Динаре?» — это запись, но ни одного слова из
// BOOKING_INTENT здесь нет. Раньше такое сообщение уходило обычному ассистенту,
// и тот радостно отвечал «запишем вас на 15:00» — не проверив, свободно ли оно,
// и ничего не записав. Лучше лишний раз спросить разборщик, чем пообещать
// клиенту время, которое уже занято.
const DAY_WORDS =
  /(сегодня|завтра|послезавтра|понедельник|вторник|сред[ауеы]|четверг|пятниц|суббот|воскресень|выходн|на неделе|числа)/i;

function looksLikeBooking(text) {
  const s = String(text || '');
  return BOOKING_INTENT.test(s) || DAY_WORDS.test(s) || mentionsTime(s);
}

const MONTH_WORDS =
  'январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр|числ';

// Есть ли в сообщении время суток. Нужно потому, что на «запишите на послезавтра»
// модель охотно дописывает час от себя — то полночь, то 15:00. Записать клиента
// на время, которого он не называл, хуже, чем переспросить: он придёт к трём,
// а его ждали к одиннадцати.
const TIME_TOKENS = [
  /\d{1,2}\s*[:.]\s*\d{2}/,                                   // 15:00, 15.00
  /\d{1,2}\s*(час|ч\b)/i,                                     // 3 часа, 5 ч
  /(в|к|на)\s*\d{1,2}(?!\s*(-?[ег]о\s*)?(%MONTHS%))/i,        // в 15, к 3 — но не «на 17 августа»
  /(в|к)\s*(час\b|два|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)/i,
  /(утр|вечер|обед|полден|полдень|ночи\b|дня\b)/i,
];

function mentionsTime(text) {
  const s = String(text || '');
  return TIME_TOKENS.some((re) =>
    new RegExp(re.source.replace('%MONTHS%', MONTH_WORDS), re.flags).test(s)
  );
}

const BOOKING_SYSTEM_PROMPT = `Ты разбираешь сообщения клиентов салона красоты (парикмахерской) на русском языке.
Твоя задача — понять, хочет ли клиент записаться, отменить запись или узнать о своей записи.

Верни ТОЛЬКО JSON без пояснений:
{"intent": "book" | "cancel" | "check" | "slots" | "none",
 "client_name": "имя клиента или null",
 "service": "название услуги или null",
 "master": "имя мастера или null",
 "datetime": "YYYY-MM-DDTHH:MM или null",
 "note": "важное уточнение клиента или null"}

Правила:
- "book" — клиент называет время и хочет записаться или перенести запись.
- "slots" — клиент спрашивает, какое время свободно, не называя часа:
  «есть окошки сегодня?», «когда можно?», «во сколько свободно завтра?», «что есть на субботу?».
  Если клиент назвал конкретный час («можно в три?») — это "book", а не "slots".
- "cancel" — клиент отменяет запись.
- "check" — клиент спрашивает, когда он записан.
- "none" — всё остальное (цены, вопросы об услугах, приветствие).
- datetime считай относительно текущего времени, указанного ниже, и возвращай без часового пояса.
- "завтра в 3" в салоне означает 15:00, а не 03:00. Время до 8 утра клиент почти никогда не имеет в виду.
- Если клиент назвал только день, без часа ("в субботу", "завтра") — верни этот день с временем 00:00.
  Час за клиента не придумывай: полночь здесь означает "день известен, время нет".
- Если время названо без дня ("в 15:00") — считай ближайший день, когда это время ещё не прошло.
- Имя бери только если клиент его действительно назвал. Не придумывай.
- Услугу и мастера указывай ТОЧНО так, как они называются в списках ниже, если сообщение им соответствует.`;

function buildSalonHint(services, nowLocalIso, weekday) {
  const lines = [`\n\nСейчас: ${nowLocalIso} (${WEEKDAYS[weekday]}).`];
  lines.push(`Салон работает с ${workHoursText()}.`);
  if (services && services.length > 0) {
    lines.push('\nУслуги салона:\n' + services.map((s) => `- ${s}`).join('\n'));
  }
  if (MASTERS.length > 0) {
    lines.push('\nМастера:\n' + MASTERS.map((m) => `- ${m}`).join('\n'));
  }
  return lines.join('\n');
}

// Те же грабли, что и в разборе склада: рассуждающие модели пишут ход мыслей
// рядом с JSON, и голый JSON.parse на этом падает.
function extractJson(raw) {
  const text = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Возвращает намерение клиента и всё, что удалось из сообщения вытащить.
// history — пара последних реплик: без них «Азамат» в ответ на «как вас зовут?»
// не превращается в имя.
async function parseBookingRequest(text, { services = [], history = [], now = new Date() } = {}) {
  const p = localParts(now);
  const messages = [
    {
      role: 'system',
      content: BOOKING_SYSTEM_PROMPT + buildSalonHint(services, localIso(now), p.weekday),
    },
    ...history.slice(-4),
    { role: 'user', content: text },
  ];

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0,
      response_format: { type: 'json_object' },
    });
  } catch (err) {
    // Разбор не удался — пусть отвечает обычный ассистент, чем клиент получит ошибку.
    console.error('Не удалось разобрать просьбу о записи:', err.message);
    return null;
  }

  const parsed = extractJson(completion.choices[0]?.message?.content || '{}');
  if (!parsed) return null;

  // Мастера ищем по списку салона, но и незнакомое имя не выбрасываем: если
  // мастера в настройках не заведены вовсе, «к Азамату» — единственный способ
  // узнать, кто ведёт запись, и терять его нельзя.
  const masterRaw = parsed.master ? String(parsed.master).trim().slice(0, 40) : null;
  const master = matchMaster(masterRaw);

  // Час берём только тогда, когда клиент его действительно назвал. Иначе это
  // день без времени: его и возвращаем отдельно, чтобы переспросить «во сколько?»,
  // а не начинать разговор заново.
  const at = localIsoToDate(parsed.datetime);
  const timed = at && mentionsTime(text);

  return {
    intent: ['book', 'cancel', 'check', 'slots'].includes(parsed.intent) ? parsed.intent : 'none',
    clientName: parsed.client_name ? String(parsed.client_name).trim().slice(0, 60) : null,
    service: parsed.service ? String(parsed.service).trim().slice(0, 80) : null,
    master: master || (MASTERS.length === 0 ? masterRaw : null),
    // Имя названо, но такого мастера в салоне нет — об этом лучше сказать вслух,
    // чем тихо записать клиента к кому попало.
    unknownMaster: masterRaw && !master && MASTERS.length > 0 ? masterRaw : null,
    when: timed ? at : null,
    day: at && !timed ? at : null,
    note: parsed.note ? String(parsed.note).trim().slice(0, 200) : null,
  };
}

module.exports = {
  TIMEZONE,
  MASTERS,
  SLOT_MINUTES,
  SLOT_STEP,
  appointmentDuration,
  LEAD_MINUTES,
  WORK_HOURS,
  workHoursText,
  localParts,
  localIso,
  localIsoToDate,
  localDayRange,
  sameLocalDay,
  addDays,
  dayOffset,
  localMinutes,
  atLocalTime,
  matchMaster,
  dayFromText,
  formatTime,
  formatDay,
  formatWhen,
  dayLabel,
  daySlots,
  availabilityAt,
  freeSlots,
  spreadSlots,
  slotLines,
  checkWhen,
  looksLikeBooking,
  parseBookingRequest,
};
