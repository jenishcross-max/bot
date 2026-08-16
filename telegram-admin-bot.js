// Телеграм-админка салона: журнал записей в кармане у владельца.
//
// Здесь нет и не должно быть склада. Раньше этот бот умел оба ремесла сразу, и
// любое непонятое сообщение уходило складскому разборщику: «запиши Азамата на
// стрижку» оседало в каталоге позицией «Стрижка, 1 шт.». Услуга — не товар,
// считать её штуками нечего, поэтому магазинной половины больше нет вовсе.
// Кому она понадобится — она цела в git под тегом shop-mode.
require('dotenv').config();

const { Telegraf, Scenes, session, Markup } = require('telegraf');
const {
  listServices,
  deleteService,
  getService,
  getServiceNames,
  saveService,
  findServiceByName,
  createAppointment,
  listAppointments,
  getAppointment,
  setAppointmentStatus,
  moveAppointment,
} = require('./db');
const { transcribeVoice } = require('./media-ai');
const salon = require('./salon');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Чего не хватает для запуска админки. Раньше на пустых переменных здесь стоял
// process.exit(1) — и это гасило весь сервис: server.js подключает этот файл
// первой строкой, так что вместе с админкой умирал и WhatsApp-бот. Одна
// незаполненная переменная — и не работает ничего, причём молча.
const MISSING_CONFIG = [
  !BOT_TOKEN && 'TELEGRAM_BOT_TOKEN',
  ADMIN_IDS.length === 0 && 'ADMIN_TELEGRAM_IDS (ваш Telegram ID, узнать у @userinfobot)',
].filter(Boolean);

// Токен-заглушка нужна только чтобы собрать объект бота: обработчики вешаются
// на него без обращений к сети, а без токена мы его просто не запускаем.
const bot = new Telegraf(BOT_TOKEN || '');

// Состояние для health-эндпоинта: по нему видно, живёт админка или молчит и почему.
const adminStatus = {
  enabled: MISSING_CONFIG.length === 0,
  mode: 'выключен',
  error: MISSING_CONFIG.length > 0 ? `не заданы ${MISSING_CONFIG.join(', ')}` : null,
};

const CURRENCY = process.env.CURRENCY || 'сом';

const MENU_TODAY = '📅 Записи на сегодня';
const MENU_UPCOMING = '🗓 Все записи';
const MENU_SLOTS = '🕒 Свободные окошки';
const MENU_BOOK = '✍️ Записать клиента';
const MENU_MASTERS = '👤 Мастера';
const MENU_LIST = '💇 Услуги и цены';
const MENU_HELP = 'ℹ️ Что я умею';
// Кнопка живёт внутри экрана услуг, а не в нижнем меню. Но подпись владелец
// видит и иногда набирает руками — пусть работает и так.
const MENU_ADD_SERVICE = '➕ Добавить услугу';

const MENU_BUTTONS = new Set([
  MENU_TODAY, MENU_UPCOMING, MENU_SLOTS, MENU_BOOK, MENU_MASTERS, MENU_LIST, MENU_HELP,
  MENU_ADD_SERVICE,
]);

const mainMenu = Markup.keyboard([
  [MENU_TODAY, MENU_UPCOMING],
  [MENU_SLOTS, MENU_BOOK],
  [MENU_MASTERS, MENU_LIST],
  [MENU_HELP],
]).resize();

bot.use((ctx, next) => {
  const userId = String(ctx.from?.id || '');
  if (!ADMIN_IDS.includes(userId)) {
    return ctx.reply('Доступ запрещён. Этот бот только для владельца салона.');
  }
  return next();
});

const SKIP = '-';

/* ---------------- услуги ----------------
   У услуги три вещи: название, цена и сколько она занимает времени. Штук,
   категорий и фотографий у неё нет. */

// «Стрижка мужская; 500; 40» -> {name, price, durationMinutes}. Разделитель
// обязателен: без него строка неотличима от записи клиента, а спутать их нельзя.
function parseServiceLine(raw) {
  const parts = String(raw || '').split(/[;|]/).map((s) => s.trim());
  if (parts.length < 2 || !parts[0]) return null;

  const price = Number(parts[1].replace(',', '.').replace(/[^\d.]/g, ''));
  if (!parts[1] || !Number.isFinite(price)) return null;

  const durationRaw = parts[2] ? Number(parts[2].replace(/[^\d]/g, '')) : NaN;
  return {
    name: parts[0],
    price,
    durationMinutes: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined,
  };
}

function serviceLine(s) {
  const price = s.price != null ? `${s.price} ${CURRENCY}` : 'цена не указана';
  // Длительность показываем всегда: пустая означает «по умолчанию», и владелец
  // должен видеть, у каких услуг он её ещё не проставил.
  const time = s.duration_minutes ? `${s.duration_minutes} мин.` : `${salon.SLOT_MINUTES} мин. (по умолчанию)`;
  return `#${s.id} ${s.name} — ${price}, ${time}`;
}

async function saveServiceText({ name, price, durationMinutes }) {
  try {
    const { service, created } = await saveService({ name, price, durationMinutes });
    return `${created ? '✅ Услуга добавлена' : '✅ Услуга обновлена'}: ${serviceLine(service)}`;
  } catch (err) {
    console.error('Не удалось сохранить услугу:', err.message);
    return `Не удалось сохранить услугу: ${err.message}`;
  }
}

const addServiceWizard = new Scenes.WizardScene(
  'add-service',
  async (ctx) => {
    await ctx.reply(
      'Название услуги? (можно сразу всё одной строкой: «Стрижка мужская; 500; 40», ' +
        'где 500 — цена, 40 — минут)\nОтправьте «-» чтобы отменить.',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    if (!raw || raw === SKIP) {
      await ctx.reply('Отменено.', mainMenu);
      return ctx.scene.leave();
    }

    // Нажатие кнопки меню — это не название услуги. Иначе в прайсе появляется
    // услуга «📅 Записи на сегодня», и удалять её потом руками.
    if (MENU_BUTTONS.has(raw)) {
      await ctx.reply('Отменил добавление услуги. Нажмите кнопку ещё раз.', mainMenu);
      return ctx.scene.leave();
    }

    const oneLine = parseServiceLine(raw);
    if (oneLine) {
      await ctx.reply(await saveServiceText(oneLine), mainMenu);
      return ctx.scene.leave();
    }

    ctx.wizard.state.name = raw;
    await ctx.reply('Цена? (число, например 500, или «-» если цена договорная)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    const price = raw === SKIP ? null : Number(raw.replace(',', '.').replace(/[^\d.]/g, ''));
    if (raw !== SKIP && !Number.isFinite(price)) {
      await ctx.reply('Не похоже на число. Введите цену ещё раз или отправьте «-»:');
      return;
    }

    ctx.wizard.state.price = price;
    await ctx.reply(
      `Сколько минут занимает? (например 40; «-» — как обычно, ${salon.SLOT_MINUTES} мин.)`
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    const minutes = raw === SKIP ? undefined : Number(raw.replace(/[^\d]/g, ''));
    if (raw !== SKIP && !(Number.isFinite(minutes) && minutes > 0)) {
      await ctx.reply('Не похоже на число минут. Напишите, например, 40 — или «-»:');
      return;
    }

    await ctx.reply(
      await saveServiceText({
        name: ctx.wizard.state.name,
        price: ctx.wizard.state.price,
        durationMinutes: minutes,
      }),
      mainMenu
    );
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([addServiceWizard]);
bot.use(session());
bot.use(stage.middleware());

/* ---------------- справка ---------------- */

const HELP_TEXT =
  'Я веду записи салона — и больше ничего: склада, остатков и «штук» здесь нет.\n\n' +
  '📅 «Записи на сегодня» — кто и во сколько придёт сегодня.\n' +
  '🗓 «Все записи» — все предстоящие, по дням.\n' +
  '🕒 «Свободные окошки» — что осталось на день, с мастерами; стрелки листают дни.\n' +
  '✍️ «Записать клиента» — пошагово: имя → телефон → мастер → услуга → день → время.\n' +
  '👤 «Мастера» — расписание каждого мастера на день.\n' +
  '💇 «Услуги и цены» — прайс с длительностью, который видит клиент в WhatsApp.\n\n' +
  'У каждой записи три кнопки: ✅ клиент пришёл, 🔄 перенести, ❌ отменить.\n' +
  'Перенос я сам сообщу клиенту в WhatsApp, если он записывался через него.\n\n' +
  'Можно и без кнопок — напишите или наговорите голосом:\n' +
  '• «запиши Азамата завтра в 15:00 на стрижку»\n' +
  '• «запись к мастеру Динаре в 11» — чего не хватит, я спрошу кнопками\n' +
  '• «что свободно в субботу?» — покажу окошки\n' +
  '• «отмени запись Азамата» — покажу его записи с кнопкой отмены\n\n' +
  'Услугу можно прислать строкой «Стрижка мужская; 500; 40» — название, цена, минуты.\n\n' +
  'Когда клиент запишется через WhatsApp — я сразу пришлю сюда его имя, время и номер, ' +
  'а отметить приход можно прямо из уведомления.';

bot.start((ctx) => ctx.reply(`Админ-бот салона.\n\n${HELP_TEXT}`, mainMenu));

async function replyServiceList(ctx) {
  const services = await listServices({ limit: 30 });
  if (services.length === 0) {
    await ctx.reply(
      'Услуг пока нет. Нажмите «➕ Добавить услугу» ниже или пришлите строкой: ' +
        '«Стрижка мужская; 500; 40».',
      Markup.inlineKeyboard([[Markup.button.callback('➕ Добавить услугу', 'svc_add')]])
    );
    return;
  }

  const noDuration = services.filter((s) => !s.duration_minutes).length;
  await ctx.reply(
    `💇 Услуги и цены\n\n${services.map(serviceLine).join('\n')}` +
      (noDuration > 0
        ? `\n\n⚠️ У ${noDuration} услуг длительность не задана — считаю их по ${salon.SLOT_MINUTES} мин. ` +
          'Пришлите строку «Название; цена; минуты», чтобы поправить.'
        : ''),
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Добавить услугу', 'svc_add')],
      [Markup.button.callback('🗑 Удалить услугу', 'svc_pick_delete')],
    ])
  );
}

bot.action('svc_add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('add-service');
});

bot.action('svc_pick_delete', async (ctx) => {
  await ctx.answerCbQuery();
  const services = await listServices({ limit: 20 });
  if (services.length === 0) {
    await ctx.reply('Услуг нет.');
    return;
  }
  await ctx.reply(
    'Какую услугу удалить?',
    Markup.inlineKeyboard(
      services.map((s) => [
        Markup.button.callback(
          `${s.name}${s.price != null ? ` — ${s.price}` : ''}`.slice(0, 60),
          `svc_del:${s.id}`
        ),
      ])
    )
  );
});

bot.action(/^svc_del:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const service = await getService(id);
  await ctx.reply(
    `Удалить услугу «${service.name}»?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Да, удалить', `svc_del_yes:${id}`),
        Markup.button.callback('❌ Отмена', 'cancel'),
      ],
    ])
  );
});

bot.action(/^svc_del_yes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await deleteService(id);
  await ctx.editMessageText(`Услуга #${id} удалена.`);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Отменено.');
});

/* ---------------- записи клиентов ---------------- */

function phoneText(a) {
  if (a.phone) return `+${a.phone}`;
  return a.chat_id ? 'написал в WhatsApp' : 'номер не указан';
}

const STATUS_MARK = { done: '✔ ', no_show: '🚫 ', cancelled: '✖ ' };

// Мастера пишем всегда, даже когда он не указан: владелец должен видеть, что
// запись «ничья», а не гадать, забыли его вписать или мастер один на весь салон.
function appointmentLine(a) {
  const at = new Date(a.starts_at);
  const till = new Date(at.getTime() + salon.appointmentDuration(a) * 60 * 1000);
  const mark = STATUS_MARK[a.status] || '';
  const head = [a.client_name, a.service].filter(Boolean).join(' · ');
  const master = a.master ? `✂️ ${a.master}` : '✂️ мастер не указан';
  const tail = [master, phoneText(a), a.note].filter(Boolean).join(' · ');
  // Время «с и до»: без него владелец не видит, что окраска займёт весь вечер.
  return `${mark}${salon.formatTime(at)}–${salon.formatTime(till)}  ${head}\n         ${tail}`;
}

// Кнопки только у предстоящих записей: отмечать приход у отменённой нечего.
//
// Кнопка одна на запись, а не четыре: действий стало больше (пришёл, перенести,
// не пришёл, отменить), и четыре подписи в ряд превращаются в нечитаемую кашу
// из обрезанных слов. Нажатие открывает карточку записи, где действия названы
// целиком и видно, к какой именно записи они относятся.
function appointmentButtons(list) {
  return list
    .filter((a) => a.status === 'active')
    .slice(0, 10)
    .map((a) => [
      Markup.button.callback(
        `${salon.formatTime(new Date(a.starts_at))} · ${a.client_name}`.slice(0, 60),
        `appt:${a.id}`
      ),
    ]);
}

function appointmentCard(a) {
  return {
    text: `Запись: ${a.client_name}\n${salon.formatWhen(new Date(a.starts_at))}` +
      `${a.service ? `\nУслуга: ${a.service}` : ''}` +
      `\nМастер: ${a.master || 'не указан'}\nТелефон: ${phoneText(a)}`,
    rows: [
      [Markup.button.callback('✅ Клиент пришёл', `appt_done:${a.id}`)],
      [Markup.button.callback('🔄 Перенести', `mv:${a.id}`)],
      [Markup.button.callback('🚫 Не пришёл', `appt_noshow:${a.id}`)],
      [Markup.button.callback('❌ Отменить запись', `appt_cancel:${a.id}`)],
      [Markup.button.callback('← Назад к списку', 'appt_back')],
    ],
  };
}

// Вчерашние записи, которые так и остались «активными». Статус за владельца мы
// не ставим — он сам решил, что прогульщиков отмечает только руками. Но молча
// забыть о них тоже нельзя: тогда история неявок будет тем точнее, чем реже
// владелец о ней вспоминает, а это ровно наоборот от того, зачем она нужна.
async function unmarkedCount() {
  try {
    const { from } = salon.localDayRange();
    const past = await listAppointments({ to: from, status: 'active', limit: 50 });
    return past.length;
  } catch (err) {
    console.error('Не удалось посчитать неотмеченные записи:', err.message);
    return 0;
  }
}

async function renderToday() {
  const { from, to } = salon.localDayRange();
  // Берём все статусы и сами убираем отменённые: пришедших клиентов из списка
  // выкидывать нельзя — владелец смотрит в него весь день и должен видеть,
  // кто уже был, а не только кто остался.
  const all = await listAppointments({ from, to, status: null, limit: 50 });
  const list = all.filter((a) => a.status !== 'cancelled');
  const stale = await unmarkedCount();
  const staleLine = stale > 0 ? `\n\n⏳ Не отмечено за прошлые дни: ${stale}. Нажмите «🗓 Все записи».` : '';

  if (list.length === 0) {
    return { text: `📅 ${salon.formatDay(new Date())}\n\nНа сегодня записей нет.${staleLine}` };
  }

  const left = list.filter((a) => a.status === 'active').length;
  return {
    text:
      `📅 ${salon.formatDay(new Date())}\n\n` +
      list.map(appointmentLine).join('\n\n') +
      `\n\nВсего ${list.length}, впереди ${left}.${staleLine}`,
    keyboard: Markup.inlineKeyboard(appointmentButtons(list)),
  };
}

async function renderUpcoming() {
  // Начинаем со вчерашних неотмеченных: они не «предстоящие», но именно их
  // владелец ищет, когда видит строчку «не отмечено за прошлые дни».
  const { from: todayStart } = salon.localDayRange();
  const stale = await listAppointments({ to: todayStart, status: 'active', limit: 20 });
  const list = await listAppointments({ from: new Date(), status: 'active', limit: 30 });

  if (list.length === 0 && stale.length === 0) {
    return { text: 'Активных записей нет. Как только клиент запишется в WhatsApp — она появится здесь.' };
  }

  // Группируем по дням: сплошной список из двадцати строк глазами не читается.
  const days = new Map();
  for (const a of list) {
    const key = salon.formatDay(new Date(a.starts_at));
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(a);
  }

  const blocks = [...days].map(([day, items]) => `📅 ${day}\n\n${items.map(appointmentLine).join('\n\n')}`);
  const head =
    stale.length > 0
      ? `⏳ Прошедшие, но не отмеченные (${stale.length}):\n\n` +
        stale.map(appointmentLine).join('\n\n') +
        '\n\n'
      : '';

  return {
    text: `${head}🗓 Активных записей: ${list.length}\n\n${blocks.join('\n\n')}`,
    keyboard: Markup.inlineKeyboard(appointmentButtons([...stale, ...list])),
  };
}

// Свободные окошки. Считаются тем же кодом, что и для клиента в WhatsApp:
// разойдись эти два расчёта — владелец пообещает по телефону время, которое
// бот в этот момент уже отдал другому.
const SLOTS_MAX_OFFSET = 14;

async function renderSlots(offset = 0) {
  const day = salon.addDays(new Date(), offset);
  const { from, to } = salon.localDayRange(day);
  const busy = await listAppointments({ from, to, status: 'active', limit: 200 });
  const slots = salon.freeSlots(day, busy);

  const nav = [];
  if (offset > 0) nav.push(Markup.button.callback('← назад', `slots:${offset - 1}`));
  if (offset < SLOTS_MAX_OFFSET) {
    nav.push(Markup.button.callback('следующий день →', `slots:${offset + 1}`));
  }
  const rows = [nav, [Markup.button.callback('✍️ Записать клиента', `bk_start:${offset}`)]];
  const keyboard = Markup.inlineKeyboard(rows);

  const head = `🕒 Свободно ${salon.dayLabel(day)}\n${salon.formatDay(day)}`;
  if (slots.length === 0) {
    return { text: `${head}\n\nОкошек нет — день расписан полностью.`, keyboard };
  }

  return {
    text:
      `${head}\n\n` +
      // Владельцу мастеров подписываем всегда: «14:00» без имени он читает как
      // «свободны все», а там может быть занят как раз тот, кого просит клиент.
      salon.slotLines(slots, { limit: 24, withMasters: true }).join('\n') +
      `\n\nВсего свободно: ${slots.length}. Сетка по ${salon.SLOT_STEP} мин.`,
    keyboard,
  };
}

async function replySlots(ctx) {
  const { text, keyboard } = await renderSlots(0);
  await ctx.reply(text, keyboard);
}

/* ---------------- мастера ----------------
   Отдельный экран: у владельца салона вопрос обычно не «что свободно вообще»,
   а «что у Динары» — она одна ведёт окрашивание, и её день расписан иначе. */

const MASTERS_MAX_OFFSET = 14;
const NO_MASTER = 'без мастера';

// Записи дня, разложенные по мастерам. Записи без мастера попадают в отдельную
// группу: потерять их нельзя, они тоже занимают кресло.
function groupByMaster(list) {
  const groups = new Map(salon.MASTERS.map((m) => [m, []]));
  for (const a of list) {
    const key = a.master && groups.has(a.master) ? a.master : a.master || NO_MASTER;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  return groups;
}

async function renderMasters(offset = 0) {
  const day = salon.addDays(new Date(), offset);
  const { from, to } = salon.localDayRange(day);
  const all = await listAppointments({ from, to, status: null, limit: 200 });
  const list = all.filter((a) => a.status !== 'cancelled');
  const active = list.filter((a) => a.status === 'active');

  const nav = [];
  if (offset > 0) nav.push(Markup.button.callback('← назад', `masters:${offset - 1}`));
  if (offset < MASTERS_MAX_OFFSET) {
    nav.push(Markup.button.callback('следующий день →', `masters:${offset + 1}`));
  }
  const keyboard = Markup.inlineKeyboard([nav, [Markup.button.callback('✍️ Записать клиента', `bk_start:${offset}`)]]);
  const head = `👤 Мастера · ${salon.dayLabel(day)}\n${salon.formatDay(day)}`;

  // Мастера не заведены — салон считается «в одно кресло». Это рабочий режим, но
  // владелец должен понимать, почему бот не спрашивает мастера и почему второй
  // клиент на то же время получает отказ.
  if (salon.MASTERS.length === 0) {
    const seen = [...new Set(list.map((a) => a.master).filter(Boolean))];
    return {
      text:
        `${head}\n\nМастера не заданы — салон считается «в одно кресло»: ` +
        'любая запись занимает время целиком.\n\n' +
        'Чтобы бот вёл расписание по мастерам и предлагал «свободна Динара», ' +
        'впишите их в настройку SALON_MASTERS через запятую (например: Айгуль,Динара) ' +
        'и перезапустите сервис.' +
        (seen.length > 0 ? `\n\nВ записях этого дня встречаются: ${seen.join(', ')}.` : ''),
      keyboard,
    };
  }

  const groups = groupByMaster(list);
  const blocks = [];
  for (const [master, items] of groups) {
    const own = master === NO_MASTER ? [] : salon.freeSlots(day, active, { masters: [master] });
    const lines = items.map((a) => {
      const mark = STATUS_MARK[a.status] || '';
      const what = [a.client_name, a.service].filter(Boolean).join(' · ');
      const at = new Date(a.starts_at);
      const till = new Date(at.getTime() + salon.appointmentDuration(a) * 60 * 1000);
      return `   ${mark}${salon.formatTime(at)}–${salon.formatTime(till)}  ${what}`;
    });

    if (master === NO_MASTER) {
      blocks.push(`❓ Без мастера\n${lines.join('\n')}`);
      continue;
    }

    const free = own.map((s) => salon.formatTime(s.at));
    blocks.push(
      `✂️ ${master}\n` +
        (lines.length > 0 ? `${lines.join('\n')}\n` : '   записей нет\n') +
        (free.length > 0 ? `   свободно: ${free.slice(0, 12).join(', ')}` : '   свободных окошек нет')
    );
  }

  return { text: `${head}\n\n${blocks.join('\n\n')}`, keyboard };
}

async function replyMasters(ctx) {
  const { text, keyboard } = await renderMasters(0);
  await ctx.reply(text, keyboard);
}

async function replyToday(ctx) {
  const { text, keyboard } = await renderToday();
  await ctx.reply(text, keyboard || mainMenu);
}

async function replyUpcoming(ctx) {
  const { text, keyboard } = await renderUpcoming();
  await ctx.reply(text, keyboard || mainMenu);
}

// После отметки перерисовываем тот же экран: иначе владелец видит старый список
// с кнопкой, которую уже нажал, и жмёт её второй раз.
async function refreshView(ctx, appointment) {
  const today = salon.sameLocalDay(new Date(appointment.starts_at), new Date());
  const { text, keyboard } = today ? await renderToday() : await renderUpcoming();
  await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard || mainMenu));
}

bot.action(/^appt:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const appointment = await getAppointment(Number(ctx.match[1]));
  const card = appointmentCard(appointment);
  await show(ctx, true, card.text, card.rows);
});

// «Назад» из карточки — тот же экран, с которого пришли. Какой именно, помним
// по времени записи: сегодняшняя открывалась из «Записи на сегодня».
bot.action('appt_back', async (ctx) => {
  await ctx.answerCbQuery();
  const { text, keyboard } = await renderToday();
  await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard || mainMenu));
});

bot.action(/^appt_done:(\d+)$/, async (ctx) => {
  const updated = await setAppointmentStatus(Number(ctx.match[1]), 'done');
  await ctx.answerCbQuery(`${updated.client_name} — отмечен`);
  await refreshView(ctx, updated);
});

bot.action(/^appt_noshow:(\d+)$/, async (ctx) => {
  const updated = await setAppointmentStatus(Number(ctx.match[1]), 'no_show');
  await ctx.answerCbQuery(`${updated.client_name} — не пришёл`);
  await refreshView(ctx, updated);
});

// То же самое, но нажатое в уведомлении о новой записи. Список сюда
// подставлять нельзя: владелец должен видеть, на какую запись он нажал,
// а не получить вместо уведомления расписание дня.
bot.action(/^n_done:(\d+)$/, async (ctx) => {
  const updated = await setAppointmentStatus(Number(ctx.match[1]), 'done');
  await ctx.answerCbQuery(`${updated.client_name} — отмечен`);
  const text = ctx.callbackQuery?.message?.text || 'Запись';
  await ctx.editMessageText(`${text}\n\n✔️ Клиент пришёл.`).catch(() => {});
});

bot.action(/^appt_cancel:(\d+)$/, async (ctx) => {
  const appointment = await getAppointment(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  await ctx.reply(
    `Отменить запись: ${appointment.client_name}, ${salon.formatWhen(new Date(appointment.starts_at))}?`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Да, отменить', `appt_cancel_yes:${appointment.id}`),
        Markup.button.callback('← Нет', 'cancel'),
      ],
    ])
  );
});

bot.action(/^appt_cancel_yes:(\d+)$/, async (ctx) => {
  const updated = await setAppointmentStatus(Number(ctx.match[1]), 'cancelled');
  await ctx.answerCbQuery('Запись отменена');
  await ctx.editMessageText(
    `❌ Запись отменена: ${updated.client_name}, ${salon.formatWhen(new Date(updated.starts_at))}`
  );
  await tellClient(
    updated,
    `Здравствуйте, ${updated.client_name}! К сожалению, вашу запись (${salon.formatWhen(
      new Date(updated.starts_at)
    )}) пришлось отменить. Напишите, и подберём другое время.`,
    ctx
  );
});

bot.action(/^slots:(\d+)$/, async (ctx) => {
  const offset = Math.min(Number(ctx.match[1]), SLOTS_MAX_OFFSET);
  const { text, keyboard } = await renderSlots(offset);
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
});

bot.action(/^masters:(\d+)$/, async (ctx) => {
  const offset = Math.min(Number(ctx.match[1]), MASTERS_MAX_OFFSET);
  const { text, keyboard } = await renderMasters(offset);
  await ctx.answerCbQuery();
  await ctx.editMessageText(text, keyboard).catch(() => ctx.reply(text, keyboard));
});

/* ---------------- сообщение клиенту в WhatsApp ----------------
   Пишем только тем, кто сам писал боту: для остальных чата нет, а слать
   сообщение первым незнакомому номеру нельзя — WhatsApp считает это спамом и
   блокирует номер салона. Владельцу в таком случае показываем телефон. */

async function tellClient(appointment, text, ctx) {
  if (appointment.chat_id) {
    // Подключаем WhatsApp-часть здесь, а не наверху файла: админка должна
    // запускаться и тогда, когда WhatsApp ещё не поднялся.
    let sent = false;
    try {
      const { sendToClient } = require('./index');
      sent = await sendToClient(appointment.chat_id, text);
    } catch (err) {
      console.error('Не удалось отправить сообщение клиенту:', err.message);
    }
    if (ctx) {
      await ctx
        .reply(sent ? '📨 Клиенту сообщил в WhatsApp.' : '⚠️ Не смог написать клиенту — сообщите ему сами.')
        .catch(() => {});
    }
    return sent;
  }

  if (ctx) {
    await ctx
      .reply(
        appointment.phone
          ? `📞 Клиент записан не через WhatsApp — позвоните: +${appointment.phone}`
          : '📞 Клиент записан не через WhatsApp, и номера у меня нет — сообщите ему сами.'
      )
      .catch(() => {});
  }
  return false;
}

/* ---------------- перенос записи ----------------
   Раньше перенести было нечем: только отменить и записать заново. В истории
   клиента от этого оставалась отменённая запись и загадочная новая, а сам
   клиент о переносе не узнавал вовсе. */

function sessionOf(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

const BOOK_DAYS_AHEAD = 6;

function dayButtons(prefix) {
  const buttons = [];
  for (let i = 0; i <= BOOK_DAYS_AHEAD; i += 1) {
    const day = salon.addDays(new Date(), i);
    const label = i === 0 ? 'сегодня' : i === 1 ? 'завтра' : salon.dayLabel(day);
    buttons.push(Markup.button.callback(label, `${prefix}${i}`));
  }
  return chunk(buttons, 2);
}

// Свободное время дня для мастера и услуги нужной длины. Тот же расчёт, что и у
// бота в WhatsApp.
async function freeSlotsFor(day, master, duration) {
  const { from, to } = salon.localDayRange(day);
  const busy = await listAppointments({ from, to, status: 'active', limit: 200 });
  const slots = salon.freeSlots(day, busy, { duration });
  if (!master || salon.MASTERS.length === 0) return slots;
  return slots.filter((s) => s.masters.includes(master));
}

bot.action(/^mv:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const appointment = await getAppointment(Number(ctx.match[1]));
  sessionOf(ctx).moving = { id: appointment.id, day: null };
  await show(
    ctx,
    false,
    `🔄 Переношу запись: ${appointment.client_name}, было ${salon.formatWhen(
      new Date(appointment.starts_at)
    )}.\n\nНа какой день?`,
    [...dayButtons('mv_d:'), [Markup.button.callback('✖️ Отмена', 'mv_cancel')]]
  );
});

bot.action(/^mv_d:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const mv = sessionOf(ctx).moving;
  if (!mv) return staleMove(ctx);

  mv.day = salon.addDays(new Date(), Math.min(Number(ctx.match[1]), BOOK_DAYS_AHEAD));
  const appointment = await getAppointment(mv.id);
  const slots = await freeSlotsFor(mv.day, appointment.master, salon.appointmentDuration(appointment));

  const rows = chunk(
    slots.slice(0, 24).map((s) => Markup.button.callback(salon.formatTime(s.at), `mv_t:${salon.localMinutes(s.at)}`)),
    4
  );
  rows.push([Markup.button.callback('← Другой день', `mv:${mv.id}`)]);
  rows.push([Markup.button.callback('✖️ Отмена', 'mv_cancel')]);

  const who = appointment.master ? ` у мастера ${appointment.master}` : '';
  await show(
    ctx,
    true,
    slots.length > 0
      ? `🔄 ${appointment.client_name}. На какое время перенести? Свободно${who} ${salon.dayLabel(mv.day)}:`
      : `🔄 ${appointment.client_name}. Свободных окошек${who} ${salon.dayLabel(mv.day)} нет — выберите другой день.`,
    rows
  );
});

bot.action(/^mv_t:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const mv = sessionOf(ctx).moving;
  if (!mv || !mv.day) return staleMove(ctx);

  const when = salon.atLocalTime(mv.day, Number(ctx.match[1]));
  const before = await getAppointment(mv.id);

  try {
    const moved = await moveAppointment(mv.id, { startsAt: when });
    sessionOf(ctx).moving = null;
    await show(
      ctx,
      true,
      `✅ Перенёс: ${moved.client_name}\n` +
        `было — ${salon.formatWhen(new Date(before.starts_at))}\n` +
        `стало — ${salon.formatWhen(new Date(moved.starts_at))}` +
        `${moved.master ? `\nМастер: ${moved.master}` : ''}`
    );
    await tellClient(
      moved,
      `Здравствуйте, ${moved.client_name}! Перенесли вашу запись: было ${salon.formatWhen(
        new Date(before.starts_at)
      )}, стало ${salon.formatWhen(new Date(moved.starts_at))}.` +
        `${moved.master ? ` Мастер: ${moved.master}.` : ''}` +
        ' Если время не подходит — напишите, подберём другое.',
      ctx
    );
  } catch (err) {
    console.error('Не удалось перенести запись:', err.message);
    await show(ctx, true, `Не удалось перенести запись.\n${err.message}`);
  }
});

bot.action('mv_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  sessionOf(ctx).moving = null;
  await show(ctx, true, 'Перенос отменён — запись осталась на своём месте.');
});

async function staleMove(ctx) {
  sessionOf(ctx).moving = null;
  await show(ctx, true, 'Этот перенос уже неактуален — начните заново кнопкой «🔄 перенести».');
}

/* ---------------- пошаговая запись клиента ----------------

   Запись — это пять вещей: кто, как позвонить, к кому, на что и когда. Свободный
   текст даёт их не всегда: во фразе «запись к мастеру Азамату в 15:00» нет имени
   клиента, а бот раньше на этом останавливался и просил переписать всё заново.
   Теперь недостающее он спрашивает кнопками, а время предлагает только свободное
   и только той длины, которой требует услуга.

   Черновик живёт в сессии владельца: одновременно он ведёт одну запись. */

function draftOf(ctx) {
  return sessionOf(ctx).booking || null;
}

function cancelRow() {
  return [Markup.button.callback('✖️ Отмена', 'bk_cancel')];
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

// Шаги идут по одному сообщению: нажатие правит его же, а не сыплет в чат
// десяток экранов. На текстовый ответ приходится отвечать новым сообщением —
// старое уже уехало вверх.
async function show(ctx, edit, text, rows) {
  const keyboard = rows && rows.length > 0 ? Markup.inlineKeyboard(rows) : undefined;
  if (edit) {
    const edited = await ctx
      .editMessageText(text, keyboard)
      .then(() => true)
      .catch(() => false);
    if (edited) return;
  }
  await ctx.reply(text, keyboard);
}

async function staleDraft(ctx) {
  sessionOf(ctx).booking = null;
  await show(ctx, true, 'Эта запись уже неактуальна — начните заново кнопкой «✍️ Записать клиента».');
}

// Что уже выбрано — показываем над каждым вопросом, иначе на пятом шаге
// владелец не помнит, кого записывает.
function draftHead(d) {
  const parts = [];
  if (d.clientName) parts.push(`👤 ${d.clientName}`);
  if (d.phone) parts.push(`📞 ${d.phone}`);
  if (d.master) parts.push(`✂️ ${d.master}`);
  else if (d.master === null && salon.MASTERS.length > 0) parts.push('✂️ любой мастер');
  if (d.service) parts.push(`💇 ${d.service}${d.duration ? ` (${d.duration} мин.)` : ''}`);
  if (d.when) parts.push(`🕒 ${salon.formatWhen(new Date(d.when))}`);
  else if (d.day) parts.push(`📅 ${salon.formatDay(new Date(d.day))}`);
  return parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
}

async function startBooking(ctx, prefill = {}, edit = false) {
  sessionOf(ctx).booking = {
    clientName: undefined,
    phone: undefined,
    master: undefined,
    service: undefined,
    duration: undefined,
    day: undefined,
    when: undefined,
    note: null,
    awaiting: null,
    ...prefill,
  };
  return askNext(ctx, edit);
}

// Спрашиваем первое, чего не хватает. Порядок один и тот же, откуда бы запись
// ни началась — с кнопки, с фразы владельца или с экрана свободных окошек.
async function askNext(ctx, edit = false) {
  const d = draftOf(ctx);
  if (!d) return staleDraft(ctx);
  d.awaiting = null;

  if (!d.clientName) return askName(ctx, edit);
  if (d.phone === undefined) return askPhone(ctx, edit);
  if (salon.MASTERS.length > 0 && d.master === undefined) return askMaster(ctx, edit);
  if (d.service === undefined) return askService(ctx, edit);
  if (!d.when) return d.day ? askTime(ctx, edit) : askDay(ctx, edit);
  return askConfirm(ctx, edit);
}

async function askName(ctx, edit) {
  const d = draftOf(ctx);
  d.awaiting = 'name';
  await show(ctx, edit, `${draftHead(d)}Как зовут клиента? Напишите имя или наговорите голосом.`, [
    cancelRow(),
  ]);
}

// Телефон нужен не ради полноты картотеки: клиенту, записанному вручную, иначе
// нельзя ни позвонить, когда он не пришёл, ни сообщить о переносе — в WhatsApp
// такой переписки нет.
async function askPhone(ctx, edit) {
  const d = draftOf(ctx);
  d.awaiting = 'phone';
  await show(ctx, edit, `${draftHead(d)}Телефон клиента? Можно пропустить.`, [
    [Markup.button.callback('Пропустить', 'bk_nophone')],
    cancelRow(),
  ]);
}

async function askMaster(ctx, edit) {
  const d = draftOf(ctx);
  const rows = chunk(
    salon.MASTERS.map((m, i) => Markup.button.callback(m, `bk_m:${i}`)),
    2
  );
  rows.push([Markup.button.callback('Любой мастер', 'bk_m:-1')]);
  rows.push(cancelRow());
  await show(ctx, edit, `${draftHead(d)}К какому мастеру?`, rows);
}

async function askService(ctx, edit) {
  const d = draftOf(ctx);

  let services = [];
  try {
    services = await listServices({ limit: 12 });
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

  // Прайс не заведён — не мучаем владельца пустым экраном, услугу можно вписать
  // потом или не указывать вовсе.
  if (services.length === 0) {
    d.service = null;
    return askNext(ctx, edit);
  }

  d.serviceChoices = services.map((p) => ({ id: p.id, name: p.name, duration: p.duration_minutes }));
  const rows = services.map((p) => [
    Markup.button.callback(
      `${p.name}${p.price != null ? ` — ${p.price}` : ''}${p.duration_minutes ? `, ${p.duration_minutes} мин.` : ''}`.slice(0, 60),
      `bk_s:${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback('Без услуги', 'bk_s:0')]);
  rows.push(cancelRow());
  await show(ctx, edit, `${draftHead(d)}Какая услуга?`, rows);
}

async function askDay(ctx, edit) {
  const d = draftOf(ctx);
  const rows = dayButtons('bk_d:');
  rows.push(cancelRow());
  await show(ctx, edit, `${draftHead(d)}На какой день записать?`, rows);
}

async function askTime(ctx, edit) {
  const d = draftOf(ctx);
  const day = new Date(d.day);

  let slots = [];
  try {
    slots = await freeSlotsFor(day, d.master, d.duration);
  } catch (err) {
    console.error('Не удалось получить свободные окошки:', err.message);
  }

  const rows = chunk(
    slots
      .slice(0, 24)
      .map((s) => Markup.button.callback(salon.formatTime(s.at), `bk_t:${salon.localMinutes(s.at)}`)),
    4
  );
  rows.push([Markup.button.callback('🕓 Другое время', 'bk_t:manual')]);
  rows.push([Markup.button.callback('← Другой день', 'bk_back_day')]);
  rows.push(cancelRow());

  const who = d.master ? ` у мастера ${d.master}` : '';
  const long = d.duration && d.duration !== salon.SLOT_MINUTES ? ` под ${d.duration} мин.` : '';
  const text =
    slots.length > 0
      ? `${draftHead(d)}Во сколько? Свободно${who}${long} ${salon.dayLabel(day)}:`
      : `${draftHead(d)}Свободных окошек${who}${long} ${salon.dayLabel(day)} нет.\n` +
        'Возьмите другой день — или впишите время вручную, тогда запишу поверх.';

  await show(ctx, edit, text, rows);
}

async function askConfirm(ctx, edit) {
  const d = draftOf(ctx);
  await show(ctx, edit, `Проверьте запись:\n\n${draftHead(d).trim()}\n\nВсё верно?`, [
    [Markup.button.callback('✅ Записать', 'bk_save')],
    [Markup.button.callback('← Другое время', 'bk_back_time')],
    cancelRow(),
  ]);
}

// Не «занято — до свидания», а предупреждение с правом записать всё равно:
// владелец видит зал и знает, поместится ли ещё один клиент.
async function bookingConflict(d) {
  let avail;
  try {
    const { from, to } = salon.localDayRange(d.when);
    const dayBusy = await listAppointments({ from, to, status: 'active', limit: 200 });
    avail = salon.availabilityAt(d.when, dayBusy, { duration: d.duration });
  } catch (err) {
    // База молчит — мешать владельцу записывать мы точно не станем.
    console.error('Не удалось проверить занятость:', err.message);
    return null;
  }

  const masterBusy = Boolean(
    d.master && salon.MASTERS.length > 0 && !avail.masters.includes(d.master)
  );
  if (avail.free && !masterBusy) return null;

  const taken = (d.master && avail.taken.find((a) => a.master === d.master)) || avail.taken[0];
  return {
    text:
      `⚠️ На это время уже есть запись${taken ? `: ${taken.client_name}` : ''}` +
      `${taken && taken.master ? ` к мастеру ${taken.master}` : ''}.\n` +
      (avail.free && avail.masters.length > 0 ? `Свободны: ${avail.masters.join(', ')}.\n` : '') +
      '\nЗаписать всё равно?',
    rows: [
      [Markup.button.callback('✅ Да, записать', 'bk_force')],
      [Markup.button.callback('← Другое время', 'bk_back_time')],
      cancelRow(),
    ],
  };
}

async function saveDraft(ctx, { force = false } = {}) {
  const d = draftOf(ctx);
  if (!d || !d.when || !d.clientName) return staleDraft(ctx);

  const check = salon.checkWhen(new Date(d.when), new Date(), { duration: d.duration });
  if (!check.ok) {
    d.when = undefined;
    await show(ctx, true, `Не записал: ${whyNotTime(check.reason)}. Выберите другое время.`, [
      [Markup.button.callback('🕒 Выбрать время', 'bk_back_time')],
      cancelRow(),
    ]);
    return;
  }

  if (!force) {
    const conflict = await bookingConflict(d);
    if (conflict) {
      await show(ctx, true, conflict.text, conflict.rows);
      return;
    }
  }

  try {
    const appointment = await createAppointment({
      clientName: d.clientName,
      phone: d.phone || null,
      service: d.service,
      master: d.master,
      startsAt: d.when,
      durationMinutes: d.duration,
      source: 'telegram',
      note: d.note,
    });
    sessionOf(ctx).booking = null;
    await show(ctx, true, bookedText(appointment));
  } catch (err) {
    console.error('Не удалось создать запись:', err.message);
    await show(ctx, true, `Не удалось сохранить запись.\n${err.message}`);
  }
}

function whyNotTime(reason) {
  if (reason === 'no_clock') return 'не указано время';
  if (reason === 'closed') return `в это время салон закрыт, работаем ${salon.workHoursText()}`;
  if (reason === 'no_time_left') return 'до закрытия услуга не успеет закончиться';
  if (reason === 'past') return 'это время уже прошло';
  if (reason === 'too_far') return 'это слишком далеко от сегодняшнего дня';
  return 'не понял время';
}

// «15:30», «в 15», «в 3» — владелец пишет цифрами, этого и хватает.
function parseClockText(text, day) {
  const m = /(\d{1,2})\s*(?:[:.\s]\s*(\d{2}))?/.exec(String(text || ''));
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (hour > 23 || minute > 59) return null;
  // «в 3» в салоне означает 15:00: в три ночи никто не стрижёт.
  if (hour * 60 < salon.WORK_HOURS.open && (hour + 12) * 60 < salon.WORK_HOURS.close) hour += 12;

  return salon.atLocalTime(day, hour * 60 + minute);
}

// Телефон из того, как его пишет владелец: «0555 12 34 56», «+996555123456».
function parsePhoneText(text) {
  const digits = String(text || '').replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

// Текст, которого ждёт открытый шаг записи. Возвращает true, если сообщение
// было ответом на вопрос бота, а не новой командой.
async function handleBookingInput(ctx, text) {
  const d = draftOf(ctx);
  if (!d || !d.awaiting) return false;

  if (d.awaiting === 'name') {
    d.clientName = text.trim().slice(0, 60);
    await askNext(ctx);
    return true;
  }

  if (d.awaiting === 'phone') {
    const phone = parsePhoneText(text);
    if (!phone) {
      await ctx.reply('Не похоже на номер. Напишите цифрами — или нажмите «Пропустить».');
      return true;
    }
    d.phone = phone;
    await askNext(ctx);
    return true;
  }

  if (d.awaiting === 'time') {
    const when = parseClockText(text, d.day || new Date());
    if (!when) {
      await ctx.reply('Не понял время. Напишите так: 15:30');
      return true;
    }
    const check = salon.checkWhen(when, new Date(), { duration: d.duration });
    if (!check.ok) {
      await ctx.reply(`Так не получится: ${whyNotTime(check.reason)}. Напишите другое время.`);
      return true;
    }
    d.when = when;
    d.day = when;
    await askNext(ctx);
    return true;
  }

  return false;
}

function bookedText(a) {
  const till = new Date(new Date(a.starts_at).getTime() + salon.appointmentDuration(a) * 60 * 1000);
  return (
    `✅ Записал: ${a.client_name}, ${salon.formatWhen(new Date(a.starts_at))}–${salon.formatTime(till)}` +
    `${a.service ? `\nУслуга: ${a.service}` : ''}` +
    `\nМастер: ${a.master || 'не указан'}` +
    `${a.phone ? `\nТелефон: +${a.phone}` : ''}`
  );
}

/* --- кнопки шагов записи --- */

bot.action(/^bk_start:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const offset = Math.min(Number(ctx.match[1]), SLOTS_MAX_OFFSET);
  await startBooking(ctx, { day: salon.addDays(new Date(), offset) });
});

bot.action('bk_nophone', async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  draft.phone = null;
  await askNext(ctx, true);
});

bot.action(/^bk_m:(-?\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  const index = Number(ctx.match[1]);
  // Время, если оно уже названо, оставляем как есть: занятость мастера всё
  // равно проверяется перед сохранением, и терять сказанное владельцем незачем.
  draft.master = index >= 0 ? salon.MASTERS[index] || null : null;
  await askNext(ctx, true);
});

bot.action(/^bk_s:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  const id = Number(ctx.match[1]);
  const picked = (draft.serviceChoices || []).find((s) => s.id === id);
  draft.service = picked ? picked.name : null;
  draft.duration = picked ? picked.duration || undefined : undefined;
  // Услуга сменилась — время могло стать невозможным (окраска на три часа в
  // 19:00). Пусть выберет заново из свободного.
  if (draft.when && draft.duration) {
    const check = salon.checkWhen(new Date(draft.when), new Date(), { duration: draft.duration });
    if (!check.ok) draft.when = undefined;
  }
  await askNext(ctx, true);
});

bot.action(/^bk_d:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  draft.day = salon.addDays(new Date(), Math.min(Number(ctx.match[1]), BOOK_DAYS_AHEAD));
  draft.when = undefined;
  await askNext(ctx, true);
});

bot.action(/^bk_t:(\d+|manual)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);

  if (ctx.match[1] === 'manual') {
    draft.awaiting = 'time';
    await show(ctx, true, `${draftHead(draft)}Во сколько записать? Напишите время, например 15:30.`, [
      [Markup.button.callback('← К списку окошек', 'bk_back_time')],
      cancelRow(),
    ]);
    return;
  }

  draft.when = salon.atLocalTime(draft.day || new Date(), Number(ctx.match[1]));
  await askNext(ctx, true);
});

bot.action('bk_back_day', async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  draft.day = undefined;
  draft.when = undefined;
  await askNext(ctx, true);
});

bot.action('bk_back_time', async (ctx) => {
  await ctx.answerCbQuery();
  const draft = draftOf(ctx);
  if (!draft) return staleDraft(ctx);
  draft.when = undefined;
  await askNext(ctx, true);
});

bot.action('bk_save', async (ctx) => {
  await ctx.answerCbQuery();
  await saveDraft(ctx);
});

// Запись поверх занятого времени — только по явному подтверждению владельца.
bot.action('bk_force', async (ctx) => {
  await ctx.answerCbQuery();
  await saveDraft(ctx, { force: true });
});

bot.action('bk_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  sessionOf(ctx).booking = null;
  await show(ctx, true, 'Отменил — ничего не записал.');
});

/* ---------------- свободный текст владельца ---------------- */

const FALLBACK =
  'Не понял. Я веду записи салона — склада и остатков здесь нет.\n\n' +
  '• «запиши Азамата завтра в 15:00 на стрижку» — новая запись\n' +
  '• «запись к мастеру Динаре в 11» — чего не хватит, спрошу кнопками\n' +
  '• «что свободно в субботу?» — свободные окошки\n' +
  '• «отмени запись Азамата» — покажу его записи\n' +
  '• «Стрижка мужская; 500; 40» — услуга, цена и минуты\n\n' +
  'Или пользуйтесь кнопками внизу.';

// Записи конкретного клиента — по имени из фразы владельца.
async function replyClientAppointments(ctx, name, intent) {
  const list = await listAppointments({ from: new Date(), status: 'active', limit: 50 });
  const key = (s) => String(s || '').toLowerCase();
  const found = name
    ? list.filter((a) => key(a.client_name).includes(key(name)) || key(name).includes(key(a.client_name)))
    : list;

  if (found.length === 0) {
    await ctx.reply(name ? `Активных записей на «${name}» не нашёл.` : 'Активных записей нет.', mainMenu);
    return;
  }

  await ctx.reply(
    (intent === 'cancel' ? 'Какую запись отменить?\n\n' : 'Нашёл записи:\n\n') +
      found.slice(0, 10).map(appointmentLine).join('\n\n'),
    Markup.inlineKeyboard(appointmentButtons(found))
  );
}

async function handleOwnerText(ctx, text) {
  // Открытый шаг записи главнее разбора: владелец сейчас отвечает на вопрос.
  if (await handleBookingInput(ctx, text)) return;

  // Единственное, что здесь не про запись, — прайс. Разделитель обязателен
  // именно поэтому: «Азамат стрижка 15:00» не должно превращаться в услугу.
  const service = parseServiceLine(text);
  if (service) {
    await ctx.reply(await saveServiceText(service), mainMenu);
    return;
  }

  let services = [];
  try {
    services = await getServiceNames();
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

  const parsed = await salon.parseBookingRequest(text, { services });
  const intent = parsed?.intent || 'none';

  if (intent === 'slots') {
    const day = parsed.day || salon.dayFromText(text) || new Date();
    const offset = Math.max(0, Math.min(salon.dayOffset(day), SLOTS_MAX_OFFSET));
    const rendered = await renderSlots(offset);
    await ctx.reply(rendered.text, rendered.keyboard);
    return;
  }

  if (intent === 'cancel' || intent === 'check') {
    await replyClientAppointments(ctx, parsed.clientName, intent);
    return;
  }

  if (intent === 'book') {
    if (parsed.unknownMaster) {
      await ctx.reply(
        `Мастера «${parsed.unknownMaster}» в списке нет — сейчас в салоне: ${salon.MASTERS.join(', ')}.`
      );
    }
    // Длительность услуги, названной словами: «на окрашивание» — это три часа,
    // и предлагать под него часовые окошки нельзя.
    let duration;
    if (parsed.service) {
      try {
        const found = await findServiceByName(parsed.service);
        duration = found?.duration_minutes || undefined;
      } catch (err) {
        console.error('Не удалось узнать длительность услуги:', err.message);
      }
    }

    await startBooking(ctx, {
      clientName: parsed.clientName || undefined,
      master: parsed.master || undefined,
      service: parsed.service || undefined,
      duration,
      when: parsed.when || undefined,
      day: parsed.when || parsed.day || undefined,
      note: parsed.note || null,
    });
    return;
  }

  await ctx.reply(FALLBACK, mainMenu);
}

/* ---------------- команды и кнопки ---------------- */

bot.command('today', replyToday);
bot.command('records', replyUpcoming);
bot.command('slots', replySlots);
bot.command('masters', replyMasters);
bot.command('book', (ctx) => startBooking(ctx));
bot.command('add', (ctx) => ctx.scene.enter('add-service'));
bot.command('list', replyServiceList);
bot.command('help', (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.hears(MENU_TODAY, replyToday);
bot.hears(MENU_UPCOMING, replyUpcoming);
bot.hears(MENU_SLOTS, replySlots);
bot.hears(MENU_MASTERS, replyMasters);
bot.hears(MENU_BOOK, (ctx) => startBooking(ctx));
bot.hears(MENU_LIST, replyServiceList);
bot.hears(MENU_ADD_SERVICE, (ctx) => ctx.scene.enter('add-service'));
bot.hears(MENU_HELP, (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.command('delete', async (ctx) => {
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) {
    await ctx.reply('Использование: /delete <id>, либо нажмите «🗑 Удалить услугу» в /list');
    return;
  }
  await deleteService(id);
  await ctx.reply(`Услуга #${id} удалена.`);
});

/* ---------------- входящие сообщения ---------------- */

bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return;

  try {
    await handleOwnerText(ctx, text);
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    await ctx.reply('Произошла ошибка при обработке сообщения.');
  }
});

// Голосовые: владельцу на работе удобнее наговорить, чем печатать.
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const file = ctx.message?.voice || ctx.message?.audio;
    const link = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(link.href);
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = await transcribeVoice(buffer);

    if (!text) {
      await ctx.reply('Не удалось разобрать голосовое сообщение. Попробуйте ещё раз.');
      return;
    }

    await ctx.reply(`🎤 Распознал: «${text}»`);
    await handleOwnerText(ctx, text);
  } catch (err) {
    console.error('Ошибка распознавания голосового:', err);
    await ctx.reply('Произошла ошибка при распознавании голосового сообщения.');
  }
});

bot.on('photo', async (ctx) => {
  await ctx.reply(
    'Фото я не разбираю — я веду записи салона. Напишите или наговорите, кого записать.',
    mainMenu
  );
});

bot.catch((err, ctx) => {
  console.error('Ошибка Telegram-бота:', err);
  ctx.reply('Произошла ошибка. Попробуйте ещё раз.').catch(() => {});
});

/* ---------------- запуск ----------------

   Получать сообщения можно двумя способами, и на Render работает только один.

   • Опрос (polling): бот сам раз в секунду спрашивает Telegram «что нового?».
     Требует, чтобы процесс всё время не спал. На бесплатном тарифе Render сервис
     засыпает через ~15 минут без входящих HTTP-запросов, и спящий бот ничего не
     опрашивает — со стороны это выглядит как «телеграм-бот вообще не работает».
   • Вебхук: Telegram сам стучится к нам по HTTPS. Этот стук ещё и будит уснувший
     сервис, поэтому на Render админка отвечает всегда.

   Поэтому: есть публичный адрес — вебхук, нет (локальный запуск) — опрос. */

const crypto = require('crypto');

// Путь секретный: кто его знает, тот может слать боту поддельные апдейты.
// Хеш токена стабилен между перезапусками и сам токен не показывает.
function webhookPath() {
  return '/telegram/' + crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);
}

const COMMANDS = [
  { command: 'today', description: 'Записи на сегодня' },
  { command: 'records', description: 'Все предстоящие записи' },
  { command: 'slots', description: 'Свободные окошки' },
  { command: 'masters', description: 'Расписание мастеров' },
  { command: 'book', description: 'Записать клиента' },
  { command: 'list', description: 'Услуги и цены' },
  { command: 'help', description: 'Что я умею' },
];

// Возвращает обработчик вебхука для HTTP-сервера, либо null — тогда работает опрос.
// server.js подключает его к своему серверу, отдельный порт заводить не нужно.
async function launchAdminBot({ publicUrl } = {}) {
  if (!adminStatus.enabled) {
    console.error(
      `Telegram-админка не запущена: ${adminStatus.error}. ` +
        'WhatsApp-бот при этом работает — заполните переменные и перезапустите сервис.'
    );
    return null;
  }

  // Список команд в меню Telegram: без него владелец не знает, что боту писать.
  bot.telegram
    .setMyCommands(COMMANDS)
    .catch((err) => console.error('Не удалось обновить меню команд:', err.message));

  const stop = (reason) => {
    try {
      bot.stop(reason);
    } catch {
      // bot.stop() падает, если бот не в режиме опроса. Гасить процесс из-за
      // этого незачем — мы и так завершаемся.
    }
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  if (publicUrl) {
    try {
      const path = webhookPath();
      const secretToken = crypto
        .createHash('sha256')
        .update(`${BOT_TOKEN}:webhook`)
        .digest('hex')
        .slice(0, 48);
      const handler = await bot.createWebhook({ domain: publicUrl, path, secret_token: secretToken });
      adminStatus.mode = 'вебхук';
      adminStatus.error = null;
      console.log(`Telegram-админка на вебхуке: ${publicUrl}${path}`);
      return handler;
    } catch (err) {
      adminStatus.error = err.message;
      console.error('Не удалось поставить вебхук, перехожу на опрос:', err.message);
    }
  }

  // bot.launch() в режиме опроса не резолвится, пока бот работает, поэтому не ждём.
  bot
    .launch()
    .catch((err) => console.error('Не удалось запустить Telegram-бота:', err.message));
  adminStatus.mode = 'опрос';
  console.log(
    'Telegram-админка запущена (опрос). Если этот же бот работает на сервере — ' +
      'запуск опроса снял там вебхук, после локальной работы перезапустите сервис.'
  );
  return null;
}

function getAdminStatus() {
  return { ...adminStatus };
}

// Запуск напрямую (npm run start:admin) — стартуем сразу; при импорте из server.js
// запуском управляет вызывающий.
if (require.main === module) {
  if (!adminStatus.enabled) {
    console.error(`Не запускаюсь: ${adminStatus.error}. Заполните .env.`);
    process.exit(1);
  }
  launchAdminBot();
}

// Готовые экраны наружу: их удобно проверять отдельно от Telegram и
// переиспользовать в сводках.
module.exports = {
  launchAdminBot,
  getAdminStatus,
  renderToday,
  renderUpcoming,
  renderSlots,
  renderMasters,
};
