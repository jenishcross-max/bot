require('dotenv').config();

const { Telegraf, Scenes, session, Markup } = require('telegraf');
const {
  LOW_STOCK_THRESHOLD,
  addProduct,
  listProducts,
  deleteProduct,
  getProduct,
  getProductNames,
  applyStockAction,
  restoreProduct,
  getStockSummary,
  saveService,
  publishServices,
  createAppointment,
  listAppointments,
  getAppointment,
  setAppointmentStatus,
} = require('./db');
const { parseStockMessage, parseInvoiceImage, transcribeVoice } = require('./stock-ai');

// Режим салона: вместо склада владельцу нужны записи клиентов. Каталог остаётся —
// в нём лежат услуги с ценами, — но главный экран другой.
const SALON_MODE = process.env.SALON_MODE === 'true';
const salon = SALON_MODE ? require('./salon') : null;

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
  salonMode: SALON_MODE,
};

const MENU_ADD = SALON_MODE ? '➕ Добавить услугу' : '➕ Добавить товар';
const MENU_BULK = '⚡ Быстрое заполнение';
const MENU_LIST = SALON_MODE ? '💇 Услуги и цены' : '📋 Список товаров';
const MENU_STATS = '📊 Остатки склада';
const MENU_HELP = 'ℹ️ Что я умею';
const MENU_TODAY = '📅 Записи на сегодня';
const MENU_UPCOMING = '🗓 Все записи';
const MENU_SLOTS = '🕒 Свободные окошки';
const MENU_BOOK = '✍️ Записать клиента';
const MENU_MASTERS = '👤 Мастера';

const MENU_BUTTONS = new Set([
  MENU_ADD, MENU_BULK, MENU_LIST, MENU_STATS, MENU_HELP,
  MENU_TODAY, MENU_UPCOMING, MENU_SLOTS, MENU_BOOK, MENU_MASTERS,
]);

const mainMenu = SALON_MODE
  ? Markup.keyboard([
      [MENU_TODAY, MENU_UPCOMING],
      [MENU_SLOTS, MENU_BOOK],
      [MENU_MASTERS, MENU_LIST],
      [MENU_HELP],
    ]).resize()
  : Markup.keyboard([
      [MENU_ADD, MENU_BULK],
      [MENU_LIST, MENU_STATS],
      [MENU_HELP],
    ]).resize();

bot.use((ctx, next) => {
  const userId = String(ctx.from?.id || '');
  if (!ADMIN_IDS.includes(userId)) {
    return ctx.reply(
      SALON_MODE
        ? 'Доступ запрещён. Этот бот только для владельца салона.'
        : 'Доступ запрещён. Этот бот только для владельца магазина.'
    );
  }
  return next();
});

// --- Мастер добавления товара вручную ---

const SKIP = '-';

const addProductWizard = new Scenes.WizardScene(
  'add-product',
  async (ctx) => {
    await ctx.reply(
      'Название товара? (или отправьте всё сразу одной строкой: «Чипсы Lays; 500; 20», ' +
        'где 500 — цена, 20 — количество)',
      Markup.removeKeyboard()
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();

    // Быстрый ввод одной строкой: «Название; цена; количество».
    if (raw.includes(';')) {
      const [name, priceRaw, qtyRaw] = raw.split(';').map((s) => s.trim());
      const price = Number((priceRaw || '').replace(',', '.'));
      const quantity = Number(qtyRaw || 0);
      const product = await addProduct({
        name,
        price: Number.isNaN(price) ? null : price,
        quantity: Number.isNaN(quantity) ? 0 : quantity,
      });
      await ctx.reply(
        `Товар добавлен (#${product.id}): ${product.name} — ${product.price ?? '—'}, остаток ${product.quantity}`,
        mainMenu
      );
      return ctx.scene.leave();
    }

    ctx.wizard.state.name = raw;
    await ctx.reply('Цена? (число, например 1500)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const price = Number((ctx.message?.text || '').replace(',', '.'));
    if (Number.isNaN(price)) {
      await ctx.reply('Не похоже на число. Введите цену ещё раз:');
      return;
    }
    ctx.wizard.state.price = price;
    await ctx.reply('Сколько штук в наличии? (число, или "-" если пока ноль)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    const quantity = raw === SKIP ? 0 : Number(raw);
    ctx.wizard.state.quantity = Number.isNaN(quantity) ? 0 : quantity;
    await ctx.reply('Описание товара? (или "-" чтобы пропустить)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    ctx.wizard.state.description = raw === SKIP ? null : raw;
    await ctx.reply('Категория товара? (или "-" чтобы пропустить)');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const raw = (ctx.message?.text || '').trim();
    ctx.wizard.state.category = raw === SKIP ? null : raw;
    await ctx.reply('Пришлите фото товара, или отправьте "-" чтобы пропустить.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    let photoUrl = null;
    if (ctx.message?.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const link = await ctx.telegram.getFileLink(photo.file_id);
      photoUrl = link.href;
    }

    const { name, price, description, category, quantity } = ctx.wizard.state;
    const product = await addProduct({ name, price, description, category, photoUrl, quantity });

    await ctx.reply(
      `Товар добавлен (#${product.id}):\n` +
        `${product.name} — ${product.price ?? '—'}, остаток ${product.quantity}\n` +
        (product.category ? `Категория: ${product.category}\n` : '') +
        (product.description ? `${product.description}\n` : ''),
      mainMenu
    );
    return ctx.scene.leave();
  }
);

// --- Быстрое заполнение: список товаров одним сообщением ---

// «Чипсы Lays; 500; 20» -> {name, price, quantity}. Разделитель ; или |,
// лишние символы в цене («500 тг») отбрасываем — владелец пишет как привык.
function parseQuickLine(line) {
  const parts = line.split(/[;|]/).map((s) => s.trim());
  if (parts.length < 2 || !parts[0]) return null;

  const [name, priceRaw = '', qtyRaw = ''] = parts;
  const priceNum = Number(priceRaw.replace(',', '.').replace(/[^\d.]/g, ''));
  const qtyNum = Number(qtyRaw.replace(/[^\d]/g, ''));

  return {
    name,
    price: priceRaw && Number.isFinite(priceNum) ? priceNum : null,
    quantity: qtyRaw && Number.isFinite(qtyNum) ? qtyNum : 0,
  };
}

const BULK_EXAMPLE =
  'Чипсы Lays; 500; 20\n' +
  'Кока-кола 0.5; 350; 48\n' +
  'Сухарики 3 короля; 100; 30';

const bulkAddWizard = new Scenes.WizardScene(
  'bulk-add',
  async (ctx) => {
    await ctx.reply(
      'Пришлите список товаров — по одному в строке, в формате «Название; цена; количество»:\n\n' +
        BULK_EXAMPLE +
        '\n\nСтроки без точки с запятой я разберу сам («приехало 10 ящиков воды по 200»).\n' +
        'Отправьте «-» чтобы отменить.',
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

    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const results = [];
    const freeform = [];

    for (const line of lines) {
      const parsed = parseQuickLine(line);
      if (!parsed) {
        freeform.push(line);
        continue;
      }
      try {
        const product = await addProduct(parsed);
        results.push(`🆕 ${product.name} — ${product.price ?? '—'}, ${product.quantity} шт.`);
      } catch (err) {
        console.error('Не удалось добавить товар из списка:', err);
        results.push(`❌ ${parsed.name} — не удалось добавить`);
      }
    }

    // Строки без разделителя отдаём ИИ — там может быть «приехало 10 ящиков воды».
    if (freeform.length > 0) {
      const catalog = await getProductNames();
      const actions = await parseStockMessage(freeform.join('\n'), catalog);
      for (const action of actions) {
        if (!action.name) continue;
        const line = formatActionResult(await applyStockAction(action));
        if (line) results.push(line);
      }
    }

    await ctx.reply(
      results.length > 0 ? `Готово:\n${results.join('\n')}` : 'Не удалось распознать ни одной строки.',
      mainMenu
    );
    return ctx.scene.leave();
  }
);

// Голос -> текст. Владельцу удобнее наговорить, чем печатать, поэтому голосовые
// принимаем и в сценариях, и в обычной переписке — расшифровка одна и та же.
async function voiceToText(ctx) {
  const file = ctx.message?.voice || ctx.message?.audio;
  if (!file) return null;
  const link = await ctx.telegram.getFileLink(file.file_id);
  const response = await fetch(link.href);
  const buffer = Buffer.from(await response.arrayBuffer());
  return transcribeVoice(buffer);
}

// --- Добавление услуги (режим салона) ---
//
// У услуги есть только название и цена. Спрашивать про неё «сколько штук в
// наличии» и «пришлите фото» — это мастер добавления товара, и он же превращал
// стрижку в складскую позицию «1 шт.».
const addServiceWizard = new Scenes.WizardScene(
  'add-service',
  async (ctx) => {
    await ctx.reply(
      'Название услуги? (можно сразу с ценой: «Стрижка мужская; 500»)\n' +
        'Отправьте «-» чтобы отменить.',
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

    await ctx.reply(await saveServiceText({ name: ctx.wizard.state.name, price }), mainMenu);
    return ctx.scene.leave();
  }
);

// «Стрижка мужская; 500» -> {name, price}. Разделитель обязателен: без него
// строка неотличима от записи клиента, а спутать их нельзя.
function parseServiceLine(raw) {
  const parts = String(raw || '').split(/[;|]/).map((s) => s.trim());
  if (parts.length < 2 || !parts[0]) return null;
  const price = Number(parts[1].replace(',', '.').replace(/[^\d.]/g, ''));
  if (!parts[1] || !Number.isFinite(price)) return null;
  return { name: parts[0], price };
}

async function saveServiceText({ name, price }) {
  try {
    const { service, created } = await saveService({ name, price });
    const priceText = service.price ?? 'цена договорная';
    return created
      ? `✅ Услуга добавлена: ${service.name} — ${priceText}`
      : `✅ Цена обновлена: ${service.name} — ${priceText}`;
  } catch (err) {
    console.error('Не удалось сохранить услугу:', err.message);
    return `Не удалось сохранить услугу: ${err.message}`;
  }
}

const stage = new Scenes.Stage(
  SALON_MODE ? [addServiceWizard] : [addProductWizard, bulkAddWizard]
);
bot.use(session());
bot.use(stage.middleware());

// --- Команды и меню ---

const SALON_HELP_TEXT =
  'Я веду записи салона — и больше ничего: склада, остатков и «штук» здесь нет.\n\n' +
  '📅 «Записи на сегодня» — кто и во сколько придёт сегодня.\n' +
  '🗓 «Все записи» — все предстоящие, по дням.\n' +
  '🕒 «Свободные окошки» — что осталось на день, с мастерами; стрелки листают дни.\n' +
  '✍️ «Записать клиента» — пошагово: имя → мастер → услуга → день → время.\n' +
  '👤 «Мастера» — расписание каждого мастера на день.\n' +
  '💇 «Услуги и цены» — прайс, который видит клиент в WhatsApp.\n\n' +
  'Кнопка ✅ отмечает, что клиент пришёл, ❌ — отменяет запись.\n\n' +
  'Можно и без кнопок — напишите или наговорите голосом:\n' +
  '• «запиши Азамата завтра в 15:00 на стрижку»\n' +
  '• «запись к мастеру Динаре в 11» — чего не хватит, я спрошу кнопками\n' +
  '• «что свободно в субботу?» — покажу окошки\n' +
  '• «отмени запись Азамата» — покажу его записи с кнопкой отмены\n\n' +
  'Цену услуги можно прислать строкой «Стрижка мужская; 500» — добавлю или обновлю.\n\n' +
  'Когда клиент запишется через WhatsApp — я сразу пришлю сюда его имя, время и номер, ' +
  'а отметить приход можно прямо из уведомления.';

const SHOP_HELP_TEXT =
  'Я веду склад магазина. Пишите или наговаривайте голосом обычными словами:\n\n' +
  '• «приехало 10 пачек сухарей» — приход\n' +
  '• «продано 5 чипсов» — списание\n' +
  '• «закончились сухарики» — обнулить остаток\n' +
  '• «переименуй сухарики в ватрушки, цена 10» — правка\n' +
  '• «сколько чипсов осталось?» — вопрос по остатку\n' +
  '• «удали товар чипсы» — удаление\n\n' +
  'Ещё можно прислать 📷 фото накладной — распознаю позиции и оприходую их.\n' +
  'После каждого изменения будет кнопка «↩️ Отменить», если я понял неправильно.\n\n' +
  '⚡ «Быстрое заполнение» — пришлите сразу весь прайс, по товару в строке:\n' +
  BULK_EXAMPLE +
  '\n\nКогда клиент в WhatsApp попросит менеджера — я пришлю сюда его номер и переписку.';

const HELP_TEXT = SALON_MODE ? SALON_HELP_TEXT : SHOP_HELP_TEXT;

bot.start((ctx) =>
  ctx.reply(`${SALON_MODE ? 'Админ-бот салона' : 'Админ-бот магазина'}.\n\n${HELP_TEXT}`, mainMenu)
);

function productLine(p) {
  const head = `#${p.id} ${p.name} — ${p.price ?? '—'}${p.category ? ` [${p.category}]` : ''}`;
  // У услуги нет остатка: «стрижка, 3 шт.» — бессмыслица. Зато важно другое:
  // клиенту в WhatsApp видны только позиции «в наличии», и услуга, заведённая
  // когда-то как товар с нулевым остатком, для него просто не существует.
  if (SALON_MODE) return `${head}${p.in_stock ? '' : ' ⚠️ скрыта от клиентов'}`;
  return `${head}, остаток: ${p.quantity ?? 0}${p.in_stock ? '' : ' (нет в наличии)'}`;
}

async function replyProductList(ctx) {
  const products = await listProducts({ limit: 30 });
  if (products.length === 0) {
    await ctx.reply(
      SALON_MODE
        ? `Услуг пока нет. Нажмите «➕ Добавить услугу» ниже или пришлите строкой: «Стрижка мужская; 500».`
        : `Товаров пока нет. Нажмите «${MENU_ADD}».`,
      SALON_MODE
        ? Markup.inlineKeyboard([[Markup.button.callback('➕ Добавить услугу', 'svc_add')]])
        : mainMenu
    );
    return;
  }

  if (SALON_MODE) {
    const hidden = products.filter((p) => !p.in_stock).length;
    const rows = [
      [Markup.button.callback('➕ Добавить услугу', 'svc_add')],
      [Markup.button.callback('🗑 Удалить услугу', 'pick_delete')],
    ];
    if (hidden > 0) rows.push([Markup.button.callback(`👁 Показать клиентам (${hidden})`, 'svc_publish')]);
    await ctx.reply(
      `💇 Услуги и цены\n\n${products.map(productLine).join('\n')}` +
        (hidden > 0 ? '\n\n⚠️ Услуги с пометкой не показываются клиенту в WhatsApp.' : ''),
      Markup.inlineKeyboard(rows)
    );
    return;
  }

  await ctx.reply(
    products.map(productLine).join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🗑 Удалить товар', 'pick_delete')],
      [Markup.button.callback('⚡ Добавить списком', 'bulk_add')],
    ])
  );
}

async function replyStockSummary(ctx) {
  const s = await getStockSummary();
  const lines = [
    `Товаров в каталоге: ${s.totalProducts}`,
    `Суммарный остаток: ${s.totalUnits} шт.`,
    `Стоимость склада: ${Math.round(s.totalValue)}`,
  ];
  if (s.lowStock.length > 0) {
    lines.push(
      '',
      `⚠️ Заканчивается (≤ ${LOW_STOCK_THRESHOLD} шт.):`,
      ...s.lowStock.map((p) => `- ${p.name}: ${p.quantity} шт.`)
    );
  }
  if (s.outOfStock.length > 0) {
    lines.push('', '❌ Нет в наличии:', ...s.outOfStock.map((p) => `- ${p.name}`));
  }
  await ctx.reply(lines.join('\n'), mainMenu);
}

/* ---------------- записи клиентов (режим салона) ---------------- */

function phoneText(a) {
  if (a.phone) return `+${a.phone}`;
  return a.chat_id ? 'написал в WhatsApp' : 'номер не указан';
}

// Мастера пишем всегда, даже когда он не указан: владелец должен видеть, что
// запись «ничья», а не гадать, забыли его вписать или мастер один на весь салон.
function appointmentLine(a) {
  const time = salon.formatTime(new Date(a.starts_at));
  const mark = a.status === 'done' ? '✔ ' : '';
  const head = [a.client_name, a.service].filter(Boolean).join(' · ');
  const master = a.master ? `✂️ ${a.master}` : '✂️ мастер не указан';
  const tail = [master, phoneText(a), a.note].filter(Boolean).join(' · ');
  return `${mark}${time}  ${head}\n         ${tail}`;
}

// Кнопки только у предстоящих записей: отмечать приход у отменённой нечего.
function appointmentButtons(list) {
  return list
    .filter((a) => a.status === 'active')
    .slice(0, 10)
    .map((a) => [
      Markup.button.callback(
        `✅ ${salon.formatTime(new Date(a.starts_at))} ${a.client_name}`,
        `appt_done:${a.id}`
      ),
      Markup.button.callback('❌ отменить', `appt_cancel:${a.id}`),
    ]);
}

async function renderToday() {
  const { from, to } = salon.localDayRange();
  // Берём все статусы и сами убираем отменённые: пришедших клиентов из списка
  // выкидывать нельзя — владелец смотрит в него весь день и должен видеть,
  // кто уже был, а не только кто остался.
  const all = await listAppointments({ from, to, status: null, limit: 50 });
  const list = all.filter((a) => a.status !== 'cancelled');

  if (list.length === 0) {
    return { text: `📅 ${salon.formatDay(new Date())}\n\nНа сегодня записей нет.` };
  }

  const left = list.filter((a) => a.status === 'active').length;
  return {
    text:
      `📅 ${salon.formatDay(new Date())}\n\n` +
      list.map(appointmentLine).join('\n\n') +
      `\n\nВсего ${list.length}, впереди ${left}.`,
    keyboard: Markup.inlineKeyboard(appointmentButtons(list)),
  };
}

async function renderUpcoming() {
  const list = await listAppointments({ from: new Date(), status: 'active', limit: 30 });
  if (list.length === 0) {
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
  return {
    text: `🗓 Активных записей: ${list.length}\n\n${blocks.join('\n\n')}`,
    keyboard: Markup.inlineKeyboard(appointmentButtons(list)),
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
    return {
      text: `${head}\n\nОкошек нет — день расписан полностью.`,
      keyboard,
    };
  }

  return {
    text:
      `${head}\n\n` +
      // Владельцу мастеров подписываем всегда: «14:00» без имени он читает как
      // «свободны все», а там может быть занят как раз тот, кого просит клиент.
      salon.slotLines(slots, { limit: 24, withMasters: true }).join('\n') +
      `\n\nВсего свободно: ${slots.length}.`,
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
      const mark = a.status === 'done' ? '✔ ' : '';
      const what = [a.client_name, a.service].filter(Boolean).join(' · ');
      return `   ${mark}${salon.formatTime(new Date(a.starts_at))}  ${what}`;
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

// Кнопки записей живут только в режиме салона: без него salon = null, и любое
// нажатие упало бы внутри обработчика.
if (SALON_MODE) {
  bot.action(/^appt_done:(\d+)$/, async (ctx) => {
    const updated = await setAppointmentStatus(Number(ctx.match[1]), 'done');
    await ctx.answerCbQuery(`${updated.client_name} — отмечен`);
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

  // --- шаги записи ---

  bot.action(/^bk_start:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const offset = Math.min(Number(ctx.match[1]), SLOTS_MAX_OFFSET);
    await startBooking(ctx, { day: salon.addDays(new Date(), offset) });
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

  bot.action('svc_add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.scene.enter('add-service');
  });

  bot.action('svc_publish', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const published = await publishServices();
      await ctx.editMessageText(
        published.length > 0
          ? `👁 Теперь клиенты видят: ${published.map((p) => p.name).join(', ')}`
          : 'Все услуги и так видны клиентам.'
      );
    } catch (err) {
      console.error('Не удалось показать услуги клиентам:', err.message);
      await ctx.reply(`Не удалось: ${err.message}`);
    }
  });
}

/* ---------------- пошаговая запись клиента ----------------

   Запись — это четыре вещи: кто, к кому, на что и когда. Свободный текст даёт
   их не всегда: во фразе «запись к мастеру Азамату в 15:00» нет имени клиента,
   а бот раньше на этом останавливался и просил переписать всё заново. Теперь
   недостающее он спрашивает кнопками, а время предлагает только свободное —
   промахнуться мимо занятого окошка попросту нечем.

   Черновик живёт в сессии владельца: одновременно он ведёт одну запись. */

const BOOK_DAYS_AHEAD = 6;

function sessionOf(ctx) {
  if (!ctx.session) ctx.session = {};
  return ctx.session;
}

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

// Что уже выбрано — показываем над каждым вопросом, иначе на четвёртом шаге
// владелец не помнит, кого записывает.
function draftHead(d) {
  const parts = [];
  if (d.clientName) parts.push(`👤 ${d.clientName}`);
  if (d.master) parts.push(`✂️ ${d.master}`);
  else if (d.master === null && salon.MASTERS.length > 0) parts.push('✂️ любой мастер');
  if (d.service) parts.push(`💇 ${d.service}`);
  if (d.when) parts.push(`🕒 ${salon.formatWhen(new Date(d.when))}`);
  else if (d.day) parts.push(`📅 ${salon.formatDay(new Date(d.day))}`);
  return parts.length > 0 ? `${parts.join('\n')}\n\n` : '';
}

async function startBooking(ctx, prefill = {}, edit = false) {
  sessionOf(ctx).booking = {
    clientName: undefined,
    master: undefined,
    service: undefined,
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
    services = await listProducts({ limit: 12 });
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

  // Прайс не заведён — не мучаем владельца пустым экраном, услугу можно вписать
  // потом или не указывать вовсе.
  if (services.length === 0) {
    d.service = null;
    return askNext(ctx, edit);
  }

  d.serviceChoices = services.map((p) => ({ id: p.id, name: p.name }));
  const rows = services.map((p) => [
    Markup.button.callback(
      `${p.name}${p.price != null ? ` — ${p.price}` : ''}`.slice(0, 60),
      `bk_s:${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback('Без услуги', 'bk_s:0')]);
  rows.push(cancelRow());
  await show(ctx, edit, `${draftHead(d)}Какая услуга?`, rows);
}

async function askDay(ctx, edit) {
  const d = draftOf(ctx);
  const buttons = [];
  for (let i = 0; i <= BOOK_DAYS_AHEAD; i += 1) {
    const day = salon.addDays(new Date(), i);
    const label = i === 0 ? 'сегодня' : i === 1 ? 'завтра' : salon.dayLabel(day);
    buttons.push(Markup.button.callback(label, `bk_d:${i}`));
  }
  const rows = chunk(buttons, 2);
  rows.push(cancelRow());
  await show(ctx, edit, `${draftHead(d)}На какой день записать?`, rows);
}

// Свободное время дня для выбранного мастера. Тот же расчёт, что и у бота в
// WhatsApp: разойдись они — владелец пообещает по телефону время, которое бот
// в этот момент уже отдал другому.
async function freeSlotsFor(day, master) {
  const { from, to } = salon.localDayRange(day);
  const busy = await listAppointments({ from, to, status: 'active', limit: 200 });
  const slots = salon.freeSlots(day, busy);
  if (!master || salon.MASTERS.length === 0) return slots;
  return slots.filter((s) => s.masters.includes(master));
}

async function askTime(ctx, edit) {
  const d = draftOf(ctx);
  const day = new Date(d.day);

  let slots = [];
  try {
    slots = await freeSlotsFor(day, d.master);
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
  const text =
    slots.length > 0
      ? `${draftHead(d)}Во сколько? Свободно${who} ${salon.dayLabel(day)}:`
      : `${draftHead(d)}Свободных окошек${who} ${salon.dayLabel(day)} нет.\n` +
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
    avail = salon.availabilityAt(d.when, dayBusy);
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

  const check = salon.checkWhen(new Date(d.when));
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
      service: d.service,
      master: d.master,
      startsAt: d.when,
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

  if (d.awaiting === 'time') {
    const when = parseClockText(text, d.day || new Date());
    if (!when) {
      await ctx.reply('Не понял время. Напишите так: 15:30');
      return true;
    }
    const check = salon.checkWhen(when);
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
  return (
    `✅ Записал: ${a.client_name}, ${salon.formatWhen(new Date(a.starts_at))}` +
    `${a.service ? `\nУслуга: ${a.service}` : ''}` +
    `\nМастер: ${a.master || 'не указан'}`
  );
}

/* ---------------- свободный текст владельца (режим салона) ---------------- */

const SALON_FALLBACK =
  'Не понял. Я веду записи салона — склада и остатков здесь нет.\n\n' +
  '• «запиши Азамата завтра в 15:00 на стрижку» — новая запись\n' +
  '• «запись к мастеру Динаре в 11» — чего не хватит, спрошу кнопками\n' +
  '• «что свободно в субботу?» — свободные окошки\n' +
  '• «отмени запись Азамата» — покажу его записи\n' +
  '• «Стрижка мужская; 500» — цена услуги\n\n' +
  'Или пользуйтесь кнопками внизу.';

// Записи конкретного клиента — по имени из фразы владельца.
async function replyClientAppointments(ctx, name, intent) {
  const list = await listAppointments({ from: new Date(), status: 'active', limit: 50 });
  const key = (s) => String(s || '').toLowerCase();
  const found = name
    ? list.filter((a) => key(a.client_name).includes(key(name)) || key(name).includes(key(a.client_name)))
    : list;

  if (found.length === 0) {
    await ctx.reply(
      name ? `Активных записей на «${name}» не нашёл.` : 'Активных записей нет.',
      mainMenu
    );
    return;
  }

  await ctx.reply(
    (intent === 'cancel' ? 'Какую запись отменить?\n\n' : 'Нашёл записи:\n\n') +
      found.slice(0, 10).map(appointmentLine).join('\n\n'),
    Markup.inlineKeyboard(appointmentButtons(found))
  );
}

async function handleSalonText(ctx, text) {
  // Открытый шаг записи главнее разбора: владелец сейчас отвечает на вопрос.
  if (await handleBookingInput(ctx, text)) return;

  // Единственное, что здесь не про запись, — цена услуги. Разделитель обязателен
  // именно поэтому: «Азамат стрижка 15:00» не должно превращаться в прайс.
  const service = parseServiceLine(text);
  if (service) {
    await ctx.reply(await saveServiceText(service), mainMenu);
    return;
  }

  let services = [];
  try {
    services = await getProductNames();
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
    await startBooking(ctx, {
      clientName: parsed.clientName || undefined,
      master: parsed.master || undefined,
      service: parsed.service || undefined,
      when: parsed.when || undefined,
      day: parsed.when || parsed.day || undefined,
      note: parsed.note || null,
    });
    return;
  }

  await ctx.reply(SALON_FALLBACK, mainMenu);
}

/* ---------------- команды и кнопки ---------------- */

if (SALON_MODE) {
  bot.command('today', replyToday);
  bot.command('records', replyUpcoming);
  bot.command('slots', replySlots);
  bot.command('masters', replyMasters);
  bot.command('book', (ctx) => startBooking(ctx));
  bot.command('add', (ctx) => ctx.scene.enter('add-service'));

  bot.hears(MENU_TODAY, replyToday);
  bot.hears(MENU_UPCOMING, replyUpcoming);
  bot.hears(MENU_SLOTS, replySlots);
  bot.hears(MENU_MASTERS, replyMasters);
  bot.hears(MENU_BOOK, (ctx) => startBooking(ctx));
  bot.hears(MENU_ADD, (ctx) => ctx.scene.enter('add-service'));
} else {
  bot.command('add', (ctx) => ctx.scene.enter('add-product'));
  bot.command('bulk', (ctx) => ctx.scene.enter('bulk-add'));
  bot.command('stats', replyStockSummary);

  bot.hears(MENU_ADD, (ctx) => ctx.scene.enter('add-product'));
  bot.hears(MENU_BULK, (ctx) => ctx.scene.enter('bulk-add'));
  bot.hears(MENU_STATS, replyStockSummary);
}

bot.command('list', replyProductList);
bot.command('help', (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.hears(MENU_LIST, replyProductList);
bot.hears(MENU_HELP, (ctx) => ctx.reply(HELP_TEXT, mainMenu));

const ITEM_ACC = SALON_MODE ? 'услугу' : 'товар';

bot.command('delete', async (ctx) => {
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) {
    await ctx.reply(`Использование: /delete <id>, либо нажмите «🗑 Удалить ${ITEM_ACC}» в /list`);
    return;
  }
  await deleteProduct(id);
  await ctx.reply(`#${id} — удалено.`);
});

// --- Удаление через инлайн-кнопки ---

bot.action('bulk_add', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.enter('bulk-add');
});

bot.action('pick_delete', async (ctx) => {
  await ctx.answerCbQuery();
  const products = await listProducts({ limit: 20 });
  if (products.length === 0) {
    await ctx.reply(SALON_MODE ? 'Услуг нет.' : 'Товаров нет.');
    return;
  }
  // У услуги показываем цену: «Стрижка (0 шт.)» — это тот самый склад, которого
  // в салоне быть не должно.
  const label = (p) =>
    SALON_MODE ? `${p.name}${p.price != null ? ` — ${p.price}` : ''}` : `${p.name} (${p.quantity ?? 0} шт.)`;
  await ctx.reply(
    `Какую ${ITEM_ACC} удалить?`,
    Markup.inlineKeyboard(products.map((p) => [Markup.button.callback(label(p).slice(0, 60), `del:${p.id}`)]))
  );
});

bot.action(/^del:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const product = await getProduct(id);
  await ctx.reply(
    SALON_MODE
      ? `Удалить услугу «${product.name}»?`
      : `Удалить «${product.name}» (остаток ${product.quantity ?? 0})?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Да, удалить', `delyes:${id}`), Markup.button.callback('❌ Отмена', 'cancel')],
    ])
  );
});

bot.action(/^delyes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await deleteProduct(id);
  await ctx.editMessageText(SALON_MODE ? `Услуга #${id} удалена.` : `Товар #${id} удалён.`);
});

bot.action('cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Отменено.');
});

// --- Применение действий, распознанных ИИ ---

function formatActionResult(result) {
  if (!result) return null;
  const p = result.product;

  if (result.action === 'created') {
    return `🆕 Создан «${p.name}», остаток: ${p.quantity} шт.`;
  }
  if (result.action === 'updated') {
    const was = result.before;
    const renamed = was && was.name !== p.name ? ` (было «${was.name}»)` : '';
    const qtyDiff =
      was && was.quantity !== p.quantity ? ` (было ${was.quantity ?? 0})` : '';
    return (
      `✅ «${p.name}»${renamed}: остаток ${p.quantity ?? 0} шт.${qtyDiff}` +
      `, цена ${p.price ?? '—'}${p.in_stock ? '' : ' — нет в наличии'}`
    );
  }
  if (result.action === 'deleted') {
    return `🗑 Товар «${p.name}» удалён.`;
  }
  if (result.action === 'query') {
    return (
      `ℹ️ «${p.name}»: ${p.quantity ?? 0} шт. в наличии, цена ${p.price ?? '—'}` +
      `${p.in_stock ? '' : ' (нет в наличии)'}`
    );
  }
  if (result.action === 'not_found') {
    return `❓ Товар «${result.name}» не найден. Добавьте его через «➕ Добавить товар».`;
  }
  return null;
}

async function applyActionsAndReply(ctx, actions, emptyMessage) {
  if (actions.length === 0) {
    await ctx.reply(emptyMessage, mainMenu);
    return;
  }

  const lines = [];
  const undoable = [];

  for (const action of actions) {
    if (!action.name) continue;
    const result = await applyStockAction(action);
    const line = formatActionResult(result);
    if (line) lines.push(line);
    if (result.before) undoable.push(result.before);
  }

  if (lines.length === 0) {
    await ctx.reply('Не удалось применить изменения.', mainMenu);
    return;
  }

  // Снимки «до» держим в сессии, чтобы кнопка отмены вернула прежние значения.
  ctx.session.undoSnapshots = undoable;

  const keyboard =
    undoable.length > 0
      ? Markup.inlineKeyboard([[Markup.button.callback('↩️ Отменить', 'undo')]])
      : undefined;

  await ctx.reply(lines.join('\n'), keyboard);
}

bot.action('undo', async (ctx) => {
  await ctx.answerCbQuery();
  const snapshots = ctx.session?.undoSnapshots;
  if (!snapshots || snapshots.length === 0) {
    await ctx.editMessageText('Отменять нечего — изменения уже неактуальны.');
    return;
  }

  const restored = [];
  for (const snapshot of snapshots) {
    try {
      const product = await restoreProduct(snapshot);
      restored.push(`«${product.name}»: остаток ${product.quantity ?? 0}, цена ${product.price ?? '—'}`);
    } catch (err) {
      console.error('Не удалось откатить изменение:', err);
    }
  }

  ctx.session.undoSnapshots = [];
  await ctx.editMessageText(
    restored.length > 0 ? `↩️ Возвращено как было:\n${restored.join('\n')}` : 'Не удалось откатить изменения.'
  );
});

// --- Входящие сообщения ---

async function handleFreeformText(ctx, text) {
  // В салоне склада нет вообще. Раньше сообщение, не распознанное как запись,
  // уходило складскому разборщику — и «запиши Азамата на стрижку» оседало в
  // каталоге позицией «Стрижка, 1 шт.». Услуга — не товар, считать её штуками
  // нечего, поэтому этой дороги здесь больше нет.
  if (SALON_MODE) {
    await handleSalonText(ctx, text);
    return;
  }

  const catalog = await getProductNames();
  const actions = await parseStockMessage(text, catalog);
  await applyActionsAndReply(
    ctx,
    actions,
    'Не смог понять, что нужно сделать. Попробуйте, например: «приехало 10 пачек сухарей» ' +
      'или нажмите «ℹ️ Что я умею».'
  );
}

bot.on('text', async (ctx) => {
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return;

  try {
    await handleFreeformText(ctx, text);
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
    await ctx.reply('Произошла ошибка при обработке сообщения.');
  }
});

// Голосовые сообщения: расшифровываем через Whisper и обрабатываем как обычный текст.
bot.on(['voice', 'audio'], async (ctx) => {
  try {
    const text = await voiceToText(ctx);
    if (!text) {
      await ctx.reply('Не удалось разобрать голосовое сообщение. Попробуйте ещё раз.');
      return;
    }

    await ctx.reply(`🎤 Распознал: «${text}»`);
    await handleFreeformText(ctx, text);
  } catch (err) {
    console.error('Ошибка распознавания голосового:', err);
    await ctx.reply('Произошла ошибка при распознавании голосового сообщения.');
  }
});

// Фото вне сценария добавления товара — считаем накладной и распознаём товары с количеством.
bot.on('photo', async (ctx) => {
  // В салоне накладных не бывает: распознавать фото в позиции склада здесь
  // просто нечем и незачем.
  if (SALON_MODE) {
    await ctx.reply(
      'Фото я не разбираю — я веду записи салона. Напишите или наговорите, кого записать.',
      mainMenu
    );
    return;
  }

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const link = await ctx.telegram.getFileLink(photo.file_id);
    const response = await fetch(link.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    await ctx.reply('📷 Распознаю накладную...');
    const catalog = await getProductNames();
    const actions = await parseInvoiceImage(buffer.toString('base64'), catalog);
    await applyActionsAndReply(
      ctx,
      actions,
      'Не удалось распознать товары на фото. Попробуйте прислать более чёткое фото накладной.'
    );
  } catch (err) {
    console.error('Ошибка распознавания накладной:', err);
    await ctx.reply('Произошла ошибка при распознавании фото.');
  }
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

const COMMANDS = SALON_MODE
  ? [
      { command: 'today', description: 'Записи на сегодня' },
      { command: 'records', description: 'Все предстоящие записи' },
      { command: 'slots', description: 'Свободные окошки' },
      { command: 'masters', description: 'Расписание мастеров' },
      { command: 'book', description: 'Записать клиента' },
      { command: 'list', description: 'Услуги и цены' },
      { command: 'help', description: 'Что я умею' },
    ]
  : [
      { command: 'list', description: 'Список товаров' },
      { command: 'stats', description: 'Остатки склада' },
      { command: 'bulk', description: 'Добавить списком' },
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

// renderToday/renderUpcoming/renderSlots наружу — это готовые экраны записей,
// их удобно проверять отдельно от Telegram и переиспользовать в сводках.
module.exports = {
  launchAdminBot,
  getAdminStatus,
  renderToday,
  renderUpcoming,
  renderSlots,
  renderMasters,
};
