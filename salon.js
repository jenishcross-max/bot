// Режим салона красоты / парикмахерской.
//
// Отличие от магазина одно, но оно меняет всё: клиенту не нужен товар, ему нужно
// время. Поэтому здесь живёт то, чего нет в магазинной части, — работа с датами
// («завтра в три» -> конкретный момент) и разбор просьбы записаться.
//
// Услуги салона лежат в той же таблице products, что и товары магазина: у услуги
// есть название и цена, а остаток для неё всегда «есть». Заводить вторую таблицу
// ради этого незачем — весь поиск по каталогу и админка работают как были.

const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Часовой пояс салона. Сервер на Render живёт по UTC, а «сегодня в 14:00» клиент
// говорит по своим часам: без пояса запись уезжает на шесть часов назад.
const TIMEZONE = process.env.SALON_TZ || 'Asia/Bishkek';
const SLOT_MINUTES = Number(process.env.SALON_SLOT_MINUTES || 60);
const MASTERS = (process.env.SALON_MASTERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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

/* ---------------- проверка времени записи ---------------- */

const MAX_AHEAD_DAYS = 120;

// Модель иногда возвращает правдоподобную чушь: прошлый год, три часа ночи,
// дату через десять лет. Пускать такое в базу нельзя — записи не должно быть
// вообще, чем должна быть неверная.
function checkWhen(date, now = new Date()) {
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
  /(запиш|записа|запис|свободн|окошк|окно|во сколько|можно (на|в|к)|приду|подойду|подъеду|отмен|перенес|перезапиш|во сколько|время есть|есть время)/i;

function looksLikeBooking(text) {
  return BOOKING_INTENT.test(String(text || ''));
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
{"intent": "book" | "cancel" | "check" | "none",
 "client_name": "имя клиента или null",
 "service": "название услуги или null",
 "master": "имя мастера или null",
 "datetime": "YYYY-MM-DDTHH:MM или null",
 "note": "важное уточнение клиента или null"}

Правила:
- "book" — клиент хочет записаться или перенести запись на новое время.
- "cancel" — клиент отменяет запись.
- "check" — клиент спрашивает, когда он записан.
- "none" — всё остальное (цены, вопросы об услугах, приветствие).
- datetime считай относительно текущего времени, указанного ниже, и возвращай без часового пояса.
- "завтра в 3" в салоне означает 15:00, а не 03:00. Время до 8 утра клиент почти никогда не имеет в виду.
- Если клиент назвал день без времени ("в субботу") — datetime оставь null.
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

  const master = MASTERS.find((m) => m.toLowerCase() === String(parsed.master || '').toLowerCase());

  // Час берём только тогда, когда клиент его действительно назвал. Иначе это
  // день без времени: его и возвращаем отдельно, чтобы переспросить «во сколько?»,
  // а не начинать разговор заново.
  const at = localIsoToDate(parsed.datetime);
  const timed = at && mentionsTime(text);

  return {
    intent: ['book', 'cancel', 'check'].includes(parsed.intent) ? parsed.intent : 'none',
    clientName: parsed.client_name ? String(parsed.client_name).trim().slice(0, 60) : null,
    service: parsed.service ? String(parsed.service).trim().slice(0, 80) : null,
    master: master || null,
    when: timed ? at : null,
    day: at && !timed ? at : null,
    note: parsed.note ? String(parsed.note).trim().slice(0, 200) : null,
  };
}

module.exports = {
  TIMEZONE,
  MASTERS,
  SLOT_MINUTES,
  WORK_HOURS,
  workHoursText,
  localParts,
  localIso,
  localIsoToDate,
  localDayRange,
  sameLocalDay,
  formatTime,
  formatDay,
  formatWhen,
  checkWhen,
  looksLikeBooking,
  parseBookingRequest,
};
