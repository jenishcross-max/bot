const Groq = require('groq-sdk');
const { notifyAdmins } = require('./notify');
const { describeClientPhoto } = require('./media-ai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

const {
  searchServices,
  getServiceNames,
  findServiceByName,
  createAppointment,
  findClientAppointments,
  setAppointmentStatus,
  listAppointments,
  countNoShows,
} = require('./db');
const salon = require('./salon');
const mastersOf = require('./masters');

// Данные салона. SHOP_* читаются запасным вариантом: они уже заполнены на
// сервере, и заставлять владельца заводить их заново ради красивого имени
// переменной — верный способ получить бота, забывшего свой адрес.
const SALON_NAME = process.env.SALON_NAME || process.env.SHOP_NAME || 'салон';
const SALON_ADDRESS = process.env.SALON_ADDRESS || process.env.SHOP_ADDRESS || '';
const SALON_PHONE = process.env.SALON_PHONE || process.env.SHOP_PHONE || '';
const SALON_HOURS_TEXT = process.env.SALON_HOURS || process.env.SHOP_HOURS || '';
// Валюта в ответах клиентам. Меняется одной переменной — «тенге», «руб» и т.д.
const CURRENCY = process.env.CURRENCY || 'сом';

// Салону продавать нечего — ему нужно занять время в кресле. Поэтому и роль
// такая: администратор, который не столько консультирует, сколько записывает.
const DEFAULT_SALON_PROMPT =
  `Ты — администратор салона красоты «${SALON_NAME}», отвечаешь клиентам в WhatsApp. ` +
  'Отвечай кратко (2-4 предложения), на русском языке, дружелюбно и по делу. ' +
  'Услуги и цены называй только по переданному списку, ничего не выдумывай. ' +
  'Если клиент интересуется услугой, но ещё не записался — предложи записать его и ' +
  'спроси, на какой день и время ему удобно. ' +
  'Саму запись не подтверждай сам: время и имя запишет система, а не ты. ' +
  'Если в сообщении клиента есть пометка в квадратных скобках о присланном фото — ' +
  'это автоматическое описание снимка. Отвечай по нему как мастер, посмотревший фото ' +
  '(например, на какую стрижку или цвет это похоже), но саму пометку не пересказывай. ' +
  'Точный результат по фото не обещай: скажи, что мастер оценит на месте.';

// Предел размера картинки для модели зрения. Фото из WhatsApp обычно
// 100–500 КБ, но клиент может прислать и несжатый снимок файлом.
const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;

const SYSTEM_PROMPT = process.env.SALON_SYSTEM_PROMPT || DEFAULT_SALON_PROMPT;

// Справка о салоне идёт отдельным системным сообщением: адрес и часы работы бот
// иначе выдумывает, а так отвечает фактами владельца.
function buildSalonInfo() {
  const lines = [];
  if (SALON_ADDRESS) lines.push(`Адрес: ${SALON_ADDRESS}`);
  if (SALON_HOURS_TEXT) lines.push(`Часы работы: ${SALON_HOURS_TEXT}`);
  if (SALON_PHONE) lines.push(`Телефон: ${SALON_PHONE}`);
  if (salon.MASTERS.length > 0) lines.push(`Мастера: ${salon.MASTERS.join(', ')}`);
  if (lines.length === 0) return null;
  return `Информация о салоне (отвечай по ней, ничего не добавляй от себя):\n${lines.join('\n')}`;
}

// Раньше справка собиралась один раз при запуске. Теперь состав салона живой:
// приняли мастера — клиент должен услышать его имя сегодня, а не после
// перезапуска сервиса.

function buildManagerText() {
  if (process.env.MANAGER_CONTACT_TEXT) return process.env.MANAGER_CONTACT_TEXT;

  const lines = ['Конечно! Передала вашу просьбу администратору — он свяжется с вами в ближайшее время.'];
  if (SALON_PHONE) lines.push(`Можете позвонить сами: ${SALON_PHONE}`);
  if (SALON_ADDRESS) lines.push(`Наш адрес: ${SALON_ADDRESS}`);
  if (SALON_HOURS_TEXT) lines.push(`Работаем: ${SALON_HOURS_TEXT}`);
  return lines.join('\n');
}

const MANAGER_TEXT = buildManagerText();

// Явные просьбы связаться с человеком. Такие сообщения не отправляем в модель:
// ответ должен быть одинаковым всегда, а владелец — получить уведомление сразу.
const MANAGER_INTENT =
  /(менеджер|оператор|живой человек|живым человеком|с человеком|консультант|перезвон|позвонит|свяж(и|итесь)|встретит|встреч|подъеха|приеха|заявк|оформить заказ|оставить заказ)/i;

// Обещание передать заявку — уже в ответе бота. Раньше уведомление владельцу
// висело только на MANAGER_INTENT, а формулировок у клиента больше, чем слов в
// списке: «беру, оформляйте», «мне нужен человек», «я куплю это» в него не
// попадали. Такой вопрос уходил в модель, модель по промпту отвечала «передаю
// заявку менеджеру» — и на этом всё заканчивалось: клиент ждал звонка, владелец
// о нём не знал. Расширять список слов бессмысленно, их всегда не хватит,
// поэтому смотрим на то, что бот уже пообещал клиенту.
const MANAGER_PROMISE =
  /(переда(ю|л|м|ёт|ет|ю́)?\s+(вашу\s+|вашей\s+)?заявк|заявк\w*\s+менеджеру|менеджеру\s+переда|менеджер\s+свяж|свяжется\s+с\s+вами)/i;

// Не чаще одного уведомления в 10 минут на чат: в длинной переписке модель
// повторяет обещание почти в каждом ответе, и владелец получит десяток
// одинаковых сообщений вместо одной заявки.
const NOTIFY_COOLDOWN_MS = 10 * 60 * 1000;
const lastNotifiedAt = new Map();

// История диалога на каждый чат: chatId -> [{role, content}, ...]
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20;

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  return conversations.get(chatId);
}

function formatServicesContext(services) {
  if (!services || services.length === 0) {
    return 'В прайсе салона пока нет подходящих услуг.';
  }
  return services
    .map((s) => {
      const price = s.price != null ? `${s.price} ${CURRENCY}` : 'цена не указана';
      // Длительность клиенту важна не меньше цены: «а сколько это по времени?» —
      // второй вопрос после «сколько стоит».
      const time = s.duration_minutes ? `, занимает ${s.duration_minutes} мин.` : '';
      return `- ${s.name}: ${price}${time}${s.description ? ` — ${s.description}` : ''}`;
    })
    .join('\n');
}

// «77015551234@s.whatsapp.net» -> «+77015551234»
//
// WhatsApp перешёл на LID-адресацию: вместо номера в чате приходит внутренний
// идентификатор вида «123456789012345@lid». Раньше здесь просто отрезалось всё
// до «@» и подставлялся плюс — владелец получал в заявке «+123456789012345»,
// правдоподобное на вид, но несуществующее число (в телефоне максимум 15 цифр
// вместе с кодом страны, и такой комбинации не бывает). Позвонить по нему нельзя.
//
// Настоящий номер достаёт index.js через маппинг из сессии и передаёт сюда
// готовым. Если достать не вышло — честно пишем, что номера нет, а не рисуем
// плюс перед идентификатором.
function formatCustomer(chatId, phone) {
  const fromPhone = String(phone || '').replace(/\D/g, '');
  if (fromPhone) return `+${fromPhone}`;

  const jid = String(chatId || '');
  if (jid.endsWith('@s.whatsapp.net')) {
    // split(':') — отрезаем номер устройства, иначе он приклеится к телефону.
    const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (digits) return `+${digits}`;
  }

  return `номер скрыт (напишите клиенту в WhatsApp, id ${jid || 'неизвестен'})`;
}

function notifyManager(chatId, userMessage, history, phone) {
  const now = Date.now();
  if (now - (lastNotifiedAt.get(chatId) || 0) < NOTIFY_COOLDOWN_MS) return;
  lastNotifiedAt.set(chatId, now);

  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Клиент' : 'Бот'}: ${m.content}`)
    .join('\n');

  notifyAdmins(
    `🔔 Клиент просит менеджера!\n\n` +
      `Номер: ${formatCustomer(chatId, phone)}\n` +
      `Сообщение: «${userMessage}»\n\n` +
      `Последние сообщения:\n${recent}`
  ).catch((err) => console.error('Не удалось уведомить владельца:', err));
}

async function handleManagerRequest(chatId, userMessage, history, phone) {
  notifyManager(chatId, userMessage, history, phone);

  history.push({ role: 'assistant', content: MANAGER_TEXT });
  return MANAGER_TEXT;
}

/* ---------------- запись клиента (режим салона) ----------------
   Запись собирается кодом, а не моделью. Модель здесь только вытаскивает из
   фразы имя, услугу и время; подтверждает запись и пишет её в базу уже код.
   Иначе бот однажды скажет «записала вас на завтра в 15:00», а записи не будет:
   клиент придёт, а его никто не ждёт. Такую ошибку салон не прощает. */

// Недособранная запись: клиент сказал «хочу подстричься завтра», имени ещё нет.
// Живёт недолго — через полчаса «Азамат» в чате это уже не ответ на «как вас зовут».
const PENDING_TTL_MS = 30 * 60 * 1000;
const pendingBookings = new Map();

// «Всё равно» в ответ на вопрос о мастере — это не имя, а разрешение выбрать
// за клиента.
const ANY_MASTER = /(любо(й|му|го)|вс[её] равно|без разницы|не важно|неважно|кто свободен|кому удобно|на ваше усмотрение)/i;

function getPending(chatId) {
  const draft = pendingBookings.get(chatId);
  if (!draft) return null;
  if (Date.now() - draft.at > PENDING_TTL_MS) {
    pendingBookings.delete(chatId);
    return null;
  }
  return draft;
}

function savePending(chatId, draft) {
  pendingBookings.set(chatId, { ...draft, at: Date.now() });
}

function bookingSummary(a) {
  const parts = [salon.formatWhen(new Date(a.starts_at))];
  if (a.service) parts.push(a.service);
  if (a.master) parts.push(`мастер ${a.master}`);
  return parts.join(', ');
}

async function notifyOwnerAboutBooking(appointment, phone) {
  const lines = [
    '🗓 Новая запись!',
    '',
    `Клиент: ${appointment.client_name}`,
    `Телефон: ${phone ? `+${String(phone).replace(/\D/g, '')}` : 'номер скрыт'}`,
    `Когда: ${salon.formatWhen(new Date(appointment.starts_at))}`,
  ];
  if (appointment.service) lines.push(`Услуга: ${appointment.service}`);
  // Мастера пишем всегда: «мастера нет в записи» — это то, что владельцу нужно
  // решить сегодня, а не заметить завтра по пустой строке.
  lines.push(`Мастер: ${appointment.master || 'не указан'}`);
  if (appointment.note) lines.push(`Пометка: ${appointment.note}`);

  // Клиент, который уже не приходил, — не повод отказать, а повод позвонить
  // накануне. Сказать об этом надо сейчас: карточку записи владелец откроет
  // хорошо если через неделю.
  try {
    const misses = await countNoShows({
      phone: appointment.phone || phone,
      chatId: appointment.chat_id,
      excludeId: appointment.id,
    });
    if (misses > 0) lines.push('', `⚠️ Этот клиент раньше не приходил: ${misses}`);
  } catch (err) {
    console.error('Не удалось посчитать неявки клиента:', err.message);
  }
  // Кнопки прямо в уведомлении: чаще всего владелец открывает его один раз —
  // когда клиент пришёл. Заставлять его ради галочки идти в список записей и
  // искать там нужную строку — лишний шаг, который никто не делает.
  await notifyAdmins(lines.join('\n'), {
    buttons: [
      [
        { text: '✅ Клиент пришёл', callback_data: `n_done:${appointment.id}` },
        { text: '❌ Отменить', callback_data: `appt_cancel:${appointment.id}` },
      ],
    ],
  });
}

/* ---------------- свободные окошки ----------------
   «У вас сегодня есть свободное время?» — самый частый вопрос после цены.
   Отвечать на него моделью нельзя: она назовёт правдоподобные часы, которых
   никто не проверял, и клиент придёт на занятое время. Считаем по расписанию. */

const SLOTS_LOOKAHEAD_DAYS = 3;

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Записи дня целиком: и свободные окошки, и занятость конкретного часа
// считаются из одного и того же списка, поэтому расходиться им негде.
async function loadDay(day) {
  const { from, to } = salon.localDayRange(day);
  return listAppointments({ from, to, status: 'active', limit: 200 });
}

async function loadFreeSlots(day, now, duration, staffNames) {
  return salon.freeSlots(day, await loadDay(day), { now, duration, masters: staffNames });
}

// Что известно о названной услуге: сколько занимает и какой у неё номер (по
// нему видно, кто из мастеров её делает). Неизвестная услуга — обычное окошко у
// любого мастера: отказывать клиенту из-за того, что он назвал стрижку своими
// словами, нельзя.
async function serviceInfo(name) {
  if (!name) return {};
  try {
    const found = await findServiceByName(name);
    return { duration: found?.duration_minutes || undefined, id: found?.id };
  } catch (err) {
    console.error('Не удалось узнать длительность услуги:', err.message);
    return {};
  }
}

// Кто свободен в конкретный момент — с поправкой на выходные и на то, кто
// делает эту услугу. avail = null, если база не ответила: молча считать время
// свободным нельзя, тогда двое придут на один час.
async function checkAvailability(when, duration, serviceId) {
  try {
    const staff = await mastersOf.staffOn(when, { serviceId });
    if (staff.configured && staff.names.length === 0) {
      // В этот день брать клиента некому: либо общий выходной, либо услугу
      // никто из работающих не делает. Занятость считать уже не по кому.
      return { staff, avail: { free: false, masters: [], taken: [] } };
    }
    const avail = salon.availabilityAt(when, await loadDay(when), {
      duration,
      masters: staff.names,
    });
    return { staff, avail };
  } catch (err) {
    console.error('Не удалось проверить занятость времени:', err.message);
    return { staff: null, avail: null };
  }
}

// Короткая строка «11:00, 13:00, 16:00» для подсказки внутри другого ответа.
async function freeTimesText(day, { master, limit = 4, duration, serviceId } = {}) {
  try {
    const staff = await mastersOf.staffOn(day, { serviceId });
    if (staff.configured && staff.names.length === 0) return null;

    let slots = await loadFreeSlots(day, new Date(), duration, staff.names);
    if (master) {
      slots = slots.filter((s) => s.masters.length === 0 || s.masters.includes(master));
    }
    if (slots.length === 0) return null;
    // Вразброс по дню, а не первые подряд: «11:00, 13:00, 15:00, 17:00» —
    // это выбор, а «09:00, 09:30, 10:00, 10:30» — только начало дня.
    return salon.spreadSlots(slots, limit).map((s) => salon.formatTime(s.at)).join(', ');
  } catch (err) {
    console.error('Не удалось посчитать свободные окошки:', err.message);
    return null;
  }
}

// Полный ответ на вопрос о свободном времени. Если спрошенный день занят
// целиком — не отвечаем «нет», а предлагаем ближайший свободный: отказ без
// альтернативы клиент читает как «идите в другой салон».
async function handleSlots(day, serviceId) {
  const now = new Date();
  const asked = day || now;
  // Спрошенный день может оказаться общим выходным. Это отдельная новость: «всё
  // занято» и «в этот день мы не работаем» клиент понимает по-разному.
  let askedDayOff = false;

  for (let i = 0; i <= SLOTS_LOOKAHEAD_DAYS; i += 1) {
    const target = salon.addDays(asked, i);
    let slots;
    let staff;
    try {
      staff = await mastersOf.staffOn(target, { serviceId });
      if (staff.configured && staff.names.length === 0) {
        if (i === 0) askedDayOff = staff.dayOff;
        continue;
      }
      slots = await loadFreeSlots(target, now, undefined, staff.names);
    } catch (err) {
      console.error('Не удалось получить расписание:', err.message);
      return null;
    }
    if (slots.length === 0) continue;

    // «Сегодня всё занято» и «сегодня мы уже закрываемся» — разные новости.
    // Первое говорит клиенту, что салон нарасхват, второе — что он опоздал на
    // сегодня. Путать их нельзя: в позднем вечернем сообщении первое звучит
    // как отговорка.
    const closed = salon
      .daySlots(asked)
      .every((at) => at.getTime() < now.getTime() + salon.LEAD_MINUTES * 60 * 1000);
    const lines = salon.slotLines(slots, { limit: 6, spread: true, masters: staff.names });
    const why = askedDayOff ? 'мы не работаем' : closed ? 'мы уже закрываемся' : 'всё занято';
    const head =
      i === 0
        ? `Свободно ${salon.dayLabel(target, now)}:`
        : `${cap(salon.dayLabel(asked, now))} ${why}. ` +
          `Ближайшее свободное — ${salon.dayLabel(target, now)}:`;
    // Список теперь растянут на весь день, поэтому «есть время и позже» звучало
    // бы странно: позже — это уже показано. Свободного больше, чем в списке,
    // и сказать об этом всё равно стоит.
    const more = slots.length > lines.length ? '\nЕсть и другое время — скажите, когда удобно.' : '';

    return `${head}\n${lines.map((l) => `• ${l}`).join('\n')}${more}\n\nНапишите время — запишу вас.`;
  }

  return 'Ближайшие дни расписаны полностью. Подскажите, на какой день вам удобно, — посмотрю, что можно освободить.';
}

async function handleCancel(chatId, phone) {
  const active = await findClientAppointments({ phone, chatId });
  if (active.length === 0) {
    return 'Не вижу за вами активных записей. Если записывались по телефону — напишите, на какое время, и я проверю.';
  }

  const cancelled = await setAppointmentStatus(active[0].id, 'cancelled');
  notifyAdmins(
    `❌ Клиент отменил запись\n\n` +
      `Клиент: ${cancelled.client_name}\n` +
      `Было: ${salon.formatWhen(new Date(cancelled.starts_at))}` +
      (cancelled.service ? `\nУслуга: ${cancelled.service}` : '')
  ).catch((err) => console.error('Не удалось сообщить владельцу об отмене:', err));

  return `Отменила запись: ${bookingSummary(cancelled)}. Будем рады видеть вас в другой раз — просто напишите, когда удобно.`;
}

async function handleCheck(chatId, phone) {
  const active = await findClientAppointments({ phone, chatId });
  if (active.length === 0) {
    return 'Активных записей за вами не вижу. Хотите записаться? Напишите день и время, которое вам удобно.';
  }
  if (active.length === 1) return `Вы записаны: ${bookingSummary(active[0])}. Ждём вас!`;
  return 'Ваши записи:\n' + active.map((a) => `• ${bookingSummary(a)}`).join('\n');
}

// Возвращает готовый ответ клиенту, либо null — тогда отвечает обычный ассистент.
async function handleBooking(chatId, userMessage, history, phone) {
  const pending = getPending(chatId);
  // Пока запись не собрана, следующее сообщение клиента — почти наверняка ответ
  // на наш вопрос, даже если слова «записаться» в нём нет.
  if (!pending && !salon.looksLikeBooking(userMessage)) return null;

  let services = [];
  try {
    services = await getServiceNames();
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

  // Состав салона освежаем до разбора: «к Динаре» ищется по справочнику, и
  // вчерашний список не узнает мастера, которого приняли сегодня.
  await mastersOf.load().catch(() => {});

  const parsed = await salon.parseBookingRequest(userMessage, {
    services,
    history: history.slice(-4),
  });
  if (!parsed) return null;

  if (parsed.intent === 'cancel') {
    pendingBookings.delete(chatId);
    return handleCancel(chatId, phone);
  }
  if (parsed.intent === 'check') return handleCheck(chatId, phone);
  if (parsed.intent === 'slots') {
    // Черновик записи не трогаем: спросить «а что вообще свободно?» клиент может
    // и посреди записи, после этого разговор должен продолжиться с того же места.
    // День берём из слов клиента, если модель его не вернула, — «завтра» она
    // в таком вопросе теряет, а показать вместо завтра сегодня хуже, чем молчать.
    const day = parsed.day || salon.dayFromText(userMessage);
    const asked = await serviceInfo(parsed.service);
    const answer = await handleSlots(day, asked.id);
    if (answer) return answer;
  }
  if (parsed.intent === 'none' && !pending) return null;

  // Собираем запись из того, что уже знали, и того, что клиент сказал сейчас.
  const draft = {
    clientName: parsed.clientName || pending?.clientName || null,
    service: parsed.service || pending?.service || null,
    master: parsed.master || pending?.master || null,
    when: parsed.when || pending?.when || null,
    day: parsed.day || pending?.day || null,
    note: parsed.note || pending?.note || null,
    anyMaster: pending?.anyMaster || false,
  };

  // Ответ на вопрос «к кому вас записать?». Короткое «к Динаре» разборщик
  // записью не считает — имя мастера ищем в сообщении сами.
  if (pending?.askedMaster) {
    if (ANY_MASTER.test(userMessage)) draft.anyMaster = true;
    else draft.master = draft.master || salon.matchMaster(userMessage);
  }

  // Услуга решает всё дальнейшее: сколько времени займёт, какие окошки под неё
  // свободны, успеет ли мастер закончить до закрытия и кто из мастеров её
  // вообще делает.
  const { duration, id: serviceId } = await serviceInfo(draft.service);

  if (!draft.when) {
    savePending(chatId, draft);
    // День клиент уже назвал — переспрашиваем только час, иначе разговор
    // начинается с нуля и это раздражает. И сразу показываем, что свободно:
    // выбрать из четырёх вариантов проще, чем угадывать время самому.
    if (draft.day) {
      const free = await freeTimesText(draft.day, { master: draft.master, duration, serviceId });
      return free
        ? `Записываю на ${salon.formatDay(draft.day)}. Свободно: ${free}. Во сколько вам удобно?`
        : `Записываю на ${salon.formatDay(draft.day)}. Во сколько вам удобно? Работаем ${salon.workHoursText()}.`;
    }
    const today = await freeTimesText(new Date(), { duration, serviceId });
    return today
      ? `Конечно, запишу вас! Сегодня свободно: ${today}. На какой день и время вам удобно?`
      : `Конечно, запишу вас! Работаем ${salon.workHoursText()}. На какой день и время вам удобно?`;
  }

  const check = salon.checkWhen(draft.when, new Date(), { duration });
  if (!check.ok) {
    // Время уже прошло или салон закрыт — записать нельзя, но и терять клиента
    // нельзя: спрашиваем другое время, а не отвечаем «не могу».
    savePending(chatId, { ...draft, when: null });
    if (check.reason === 'no_clock') {
      return `Хорошо! А во сколько вам удобно? Работаем ${salon.workHoursText()}.`;
    }
    if (check.reason === 'closed') {
      const free = await freeTimesText(draft.when, { master: draft.master, duration, serviceId });
      return free
        ? `В это время мы уже закрыты — работаем ${salon.workHoursText()}. ${cap(salon.dayLabel(draft.when))} свободно: ${free}. Какое подходит?`
        : `В это время мы уже закрыты — работаем ${salon.workHoursText()}. Подберём другое время?`;
    }
    // Начать успеваем, а закончить нет: услуга длинная, а до закрытия близко.
    if (check.reason === 'no_time_left') {
      const free = await freeTimesText(draft.when, { master: draft.master, duration, serviceId });
      const what = draft.service ? `на «${draft.service}»` : 'на эту услугу';
      return free
        ? `До закрытия не успеем ${what} — работаем ${salon.workHoursText()}. ${cap(salon.dayLabel(draft.when))} свободно: ${free}. Какое подходит?`
        : `До закрытия не успеем ${what} — работаем ${salon.workHoursText()}. Давайте подберём другой день?`;
    }
    if (check.reason === 'past') {
      return 'Это время уже прошло. На какой ближайший день вас записать?';
    }
    return 'Не поняла время записи. Напишите, пожалуйста, день и час — например «завтра в 15:00».';
  }

  // Занятость проверяем до вопроса об имени. В обратном порядке разговор выходит
  // издевательский: бот спрашивает «как вас записать?», клиент представляется —
  // и только тогда узнаёт, что это время занято.
  const { avail, staff } = await checkAvailability(draft.when, duration, serviceId);

  // В этот день клиента брать некому — и причина у этого бывает разная.
  if (staff && staff.configured && staff.names.length === 0) {
    savePending(chatId, { ...draft, when: null });
    const next = await handleSlots(salon.addDays(draft.when, 1), serviceId);
    if (staff.dayOff) {
      return (
        `${cap(salon.dayLabelIn(draft.when))} у нас выходной — в этот день никто не работает.\n` +
        (next || 'Подскажите другой день, и я подберу время.')
      );
    }
    const what = draft.service ? `«${draft.service}»` : 'эту услугу';
    return (
      `${cap(salon.dayLabelIn(draft.when))} ${what} никто из мастеров не делает — ` +
      'в этот день работают другие.\n' +
      (next || 'Подскажите другой день, и я подберу время.')
    );
  }

  // Клиент попросил мастера, которого в этот день не будет. Это не «занято»:
  // отвечать «занято» про человека в отпуске — значит обещать, что через час
  // освободится.
  const masterAway = Boolean(
    draft.master && staff && staff.configured && !staff.names.includes(draft.master)
  );
  if (masterAway) {
    savePending(chatId, { ...draft, master: null, askedMaster: true });
    const free = staff.names.join(', ');
    return (
      `${draft.master} ${salon.dayLabelIn(draft.when)} не работает.\n` +
      (free
        ? `В это время могут принять: ${free}. Записать к кому-то из них — или подобрать день, когда выйдет ${draft.master}?`
        : `Подскажите другой день — посмотрю, когда выйдет ${draft.master}.`)
    );
  }

  const masterBusy = Boolean(
    avail && draft.master && staff && staff.names.length > 0 && !avail.masters.includes(draft.master)
  );

  if (avail && (!avail.free || masterBusy)) {
    // Занят конкретный мастер, а кресло рядом свободно — предлагаем коллегу.
    // Клиент чаще хочет попасть в это время, чем именно к этому мастеру.
    if (masterBusy && avail.free) {
      savePending(chatId, { ...draft, master: null });
      return (
        `Это время уже занято (мастер: ${draft.master}).\n` +
        `В ${salon.formatTime(draft.when)} свободна запись к другому мастеру: ${avail.masters.join(', ')}. Записать?`
      );
    }

    savePending(chatId, { ...draft, when: null });
    // «Занято, напишите другое время» — это работа, переложенная на клиента.
    // Сразу называем свободные часы того же дня: так он выбирает, а не гадает.
    const free = await freeTimesText(draft.when, { master: draft.master, duration });
    const head = draft.master ? `Это время уже занято (мастер: ${draft.master}).` : 'Это время уже занято.';
    return free
      ? `${head} ${cap(salon.dayLabel(draft.when))} свободно: ${free}. Какое подходит?`
      : `${head} На этот день свободных окошек не осталось. На какой другой день вас записать?`;
  }

  // К кому записать — спрашиваем только здесь и только один раз. Раньше времени
  // этот вопрос задавать бессмысленно: пока час не выбран, неизвестно, кто в
  // этот час вообще свободен. А если свободен один — вопроса не будет вовсе.
  const freeMasters = avail ? avail.masters : [];
  const hasMasters = Boolean(staff && staff.configured);
  if (hasMasters && !draft.master && !draft.anyMaster && freeMasters.length > 1) {
    savePending(chatId, { ...draft, askedMaster: true });
    return (
      `${cap(salon.formatWhen(draft.when))} свободны: ${freeMasters.join(', ')}. ` +
      'К кому вас записать? Можно ответить «всё равно» — посажу к свободному.'
    );
  }
  if (hasMasters && !draft.master && freeMasters.length > 0) {
    draft.master = freeMasters[0];
  }

  if (!draft.clientName) {
    savePending(chatId, draft);
    return `Записываю на ${salon.formatWhen(draft.when)}. Как вас записать — подскажите имя?`;
  }

  try {
    const appointment = await createAppointment({
      clientName: draft.clientName,
      phone,
      chatId,
      service: draft.service,
      master: draft.master,
      // Ссылка на справочник мастеров: по ней запись остаётся привязанной к
      // человеку, даже если владелец потом поправит написание имени.
      masterId: draft.master ? await mastersOf.idByName(draft.master) : undefined,
      startsAt: draft.when,
      durationMinutes: duration,
      source: 'whatsapp',
      note: draft.note,
    });

    pendingBookings.delete(chatId);
    // Ответа не ждём: клиент не должен ждать в переписке, пока сходит
    // уведомление владельцу.
    notifyOwnerAboutBooking(appointment, phone).catch((err) =>
      console.error('Не удалось сообщить владельцу о записи:', err.message)
    );

    const lines = [`Готово, ${draft.clientName}! Записала вас: ${bookingSummary(appointment)}.`];
    if (SALON_ADDRESS) lines.push(`Адрес: ${SALON_ADDRESS}`);
    lines.push('Если планы поменяются — напишите, перенесём.');
    return lines.join('\n');
  } catch (err) {
    // База недоступна — обещать запись нельзя, иначе клиент придёт в никуда.
    console.error('Не удалось создать запись:', err.message);
    pendingBookings.delete(chatId);
    notifyAdmins(
      `⚠️ Не смог записать клиента!\n\n` +
        `Клиент: ${draft.clientName}\n` +
        `Просил: ${salon.formatWhen(draft.when)}\n` +
        `Телефон: ${phone ? `+${String(phone).replace(/\D/g, '')}` : 'номер скрыт'}\n\n` +
        'Свяжитесь с ним сами.'
    ).catch(() => {});
    return 'Секунду, не получилось записать автоматически — передала вашу заявку администратору, он свяжется с вами.';
  }
}

// Фото от клиента: смотрим на него моделью зрения и превращаем в текст.
// Дальше всё идёт обычным путём — описание участвует и в поиске по каталогу,
// и в истории диалога, чтобы «а в чёрном есть?» через сообщение всё ещё
// относилось к той самой футболке.
async function describePhoto(photo, caption) {
  if (!photo || !photo.data) return null;

  // Модель принимает картинку строкой base64, а на неё есть предел размера.
  // Фото из WhatsApp обычно 100–500 КБ, но снимок с хорошей камеры бывает
  // и больше — тогда честнее ответить по подписи, чем упасть с ошибкой.
  if (photo.data.length > MAX_PHOTO_BYTES) {
    console.error(`Фото слишком большое (${Math.round(photo.data.length / 1024)} КБ), пропускаю распознавание.`);
    return null;
  }

  try {
    return await describeClientPhoto(photo.data.toString('base64'), photo.mimeType, caption);
  } catch (err) {
    console.error('Не удалось распознать фото клиента:', err.message);
    return null;
  }
}

// phone — настоящий номер клиента, который index.js достаёт из LID-маппинга.
// В чате его может не быть: WhatsApp адресует по идентификатору, а не по номеру.
// photo — картинка из сообщения, если клиент прислал фото.
async function getAIReply(chatId, userMessage, { phone, photo } = {}) {
  const history = getHistory(chatId);

  const seen = await describePhoto(photo, userMessage);
  // В историю кладём то, что бот на самом деле «увидел»: без этого в следующем
  // сообщении фото для модели просто не существует.
  const entry = seen
    ? `${userMessage || '(без подписи)'}\n[клиент прислал фото, на нём: ${seen.description}]`
    : userMessage;

  history.push({ role: 'user', content: entry });

  // Запись проверяем раньше просьбы позвать человека: «приеду в три» — это про
  // время, а не про администратора, но в MANAGER_INTENT такие слова тоже попадают.
  const booking = await handleBooking(chatId, userMessage, history, phone);
  if (booking) {
    history.push({ role: 'assistant', content: booking });
    return booking;
  }

  // В заявку владельцу уходит entry, а не userMessage: если клиент прислал
  // только фото без подписи, в уведомлении иначе будет пустая строка вместо
  // «на фото такая-то стрижка».
  if (MANAGER_INTENT.test(userMessage)) {
    return handleManagerRequest(chatId, entry, history, phone);
  }

  const systemMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const salonInfo = buildSalonInfo();
  if (salonInfo) {
    systemMessages.push({ role: 'system', content: salonInfo });
  }
  try {
    // По фото ищем словами, которые подобрала модель зрения: подпись вроде
    // «а так сможете?» для поиска бесполезна, а «окрашивание блонд» — нет.
    const services = await searchServices((seen && seen.query) || userMessage);
    systemMessages.push({
      role: 'system',
      content:
        'Вот услуги салона, подходящие под вопрос клиента. Отвечай только по этим данным, ' +
        'ничего не выдумывай про услуги, которых здесь нет:\n' + formatServicesContext(services),
    });
  } catch (err) {
    console.error('Не удалось получить услуги из базы:', err);
  }

  const messages = [
    ...systemMessages,
    ...history.slice(-MAX_HISTORY_MESSAGES),
  ];

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 800,
  });

  const reply = completion.choices[0]?.message?.content?.trim() || 'Извините, не смогла сформировать ответ.';

  // Бот пообещал клиенту передать заявку — значит, владелец обязан её получить,
  // даже если вопрос не попал в MANAGER_INTENT.
  if (MANAGER_PROMISE.test(reply)) {
    notifyManager(chatId, entry, history, phone);
  }

  history.push({ role: 'assistant', content: reply });
  return reply;
}

function resetHistory(chatId) {
  conversations.delete(chatId);
  lastNotifiedAt.delete(chatId);
  pendingBookings.delete(chatId);
}

module.exports = { getAIReply, resetHistory };
