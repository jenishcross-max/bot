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
  createAppointment,
  listAppointments,
  getAppointment,
  setAppointmentStatus,
  findBusyAppointment,
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

if (!BOT_TOKEN) {
  console.error('Не задан TELEGRAM_BOT_TOKEN в .env');
  process.exit(1);
}
if (ADMIN_IDS.length === 0) {
  console.error('Не задан ADMIN_TELEGRAM_IDS в .env (ваш Telegram ID, узнать можно у @userinfobot)');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const MENU_ADD = SALON_MODE ? '➕ Добавить услугу' : '➕ Добавить товар';
const MENU_BULK = '⚡ Быстрое заполнение';
const MENU_LIST = SALON_MODE ? '💇 Услуги и цены' : '📋 Список товаров';
const MENU_STATS = '📊 Остатки склада';
const MENU_HELP = 'ℹ️ Что я умею';
const MENU_TODAY = '📅 Записи на сегодня';
const MENU_UPCOMING = '🗓 Активные записи';

const mainMenu = SALON_MODE
  ? Markup.keyboard([
      [MENU_TODAY, MENU_UPCOMING],
      [MENU_LIST, MENU_ADD],
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

const stage = new Scenes.Stage([addProductWizard, bulkAddWizard]);
bot.use(session());
bot.use(stage.middleware());

// --- Команды и меню ---

const SALON_HELP_TEXT =
  'Я веду записи салона.\n\n' +
  '📅 «Записи на сегодня» — кто и во сколько придёт сегодня.\n' +
  '🗓 «Активные записи» — все предстоящие, по дням.\n' +
  'Кнопка ✅ отмечает, что клиент пришёл, ❌ — отменяет запись.\n\n' +
  'Записать клиента самому — просто напишите или наговорите голосом:\n' +
  '• «запиши Азамата завтра в 15:00 на стрижку»\n' +
  '• «Нурия, окрашивание, в субботу в 11 к Динаре»\n\n' +
  'Услуги и цены ведутся так же, как товары:\n' +
  '• «стрижка мужская 500» — добавить или поправить цену\n' +
  '• «удали услугу маникюр» — убрать\n\n' +
  'Когда клиент запишется через WhatsApp — я сразу пришлю сюда его имя, время и номер.';

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

bot.command('add', (ctx) => ctx.scene.enter('add-product'));

function productLine(p) {
  const head = `#${p.id} ${p.name} — ${p.price ?? '—'}${p.category ? ` [${p.category}]` : ''}`;
  // У услуги нет остатка: «стрижка, 3 шт.» — бессмыслица.
  if (SALON_MODE) return head;
  return `${head}, остаток: ${p.quantity ?? 0}${p.in_stock ? '' : ' (нет в наличии)'}`;
}

async function replyProductList(ctx) {
  const products = await listProducts({ limit: 30 });
  if (products.length === 0) {
    await ctx.reply(`${SALON_MODE ? 'Услуг' : 'Товаров'} пока нет. Нажмите «${MENU_ADD}».`, mainMenu);
    return;
  }
  await ctx.reply(
    products.map(productLine).join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback(SALON_MODE ? '🗑 Удалить услугу' : '🗑 Удалить товар', 'pick_delete')],
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

function appointmentLine(a) {
  const time = salon.formatTime(new Date(a.starts_at));
  const head = [a.client_name, a.service, a.master && `мастер ${a.master}`].filter(Boolean).join(' · ');
  const mark = a.status === 'done' ? '✔ ' : '';
  const tail = [phoneText(a), a.note].filter(Boolean).join(' · ');
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

bot.action(/^appt_done:(\d+)$/, async (ctx) => {
  const updated = await setAppointmentStatus(Number(ctx.match[1]), 'done');
  await ctx.answerCbQuery(`${updated.client_name} — отмечен`);
  await refreshView(ctx, updated);
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

// Владелец записывает клиента сам — он принял звонок, пока бот спал.
// Возвращает true, если сообщение было про запись и обработано здесь.
async function handleOwnerBooking(ctx, text) {
  let services = [];
  try {
    services = await getProductNames();
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

  const parsed = await salon.parseBookingRequest(text, { services });
  if (!parsed || parsed.intent !== 'book') return false;

  if (!parsed.when || !parsed.clientName) {
    const missing = [
      !parsed.clientName && 'имя клиента',
      !parsed.when && (parsed.day ? 'время' : 'день и время'),
    ]
      .filter(Boolean)
      .join(' и ');
    await ctx.reply(
      `Понял, что нужно записать, но не хватает: ${missing}.\n` +
        'Напишите одной строкой, например: «запиши Азамата завтра в 15:00 на стрижку».',
      mainMenu
    );
    return true;
  }

  const check = salon.checkWhen(parsed.when);
  if (!check.ok) {
    const why =
      check.reason === 'no_clock'
        ? 'не указано время'
        : check.reason === 'closed'
          ? `в это время салон закрыт (работаем ${salon.workHoursText()})`
          : check.reason === 'past'
            ? 'это время уже прошло'
            : 'не понял время';
    await ctx.reply(`Не записал: ${why}. Напишите другое время.`, mainMenu);
    return true;
  }

  const busy = await findBusyAppointment(parsed.when, {
    master: parsed.master,
    durationMinutes: salon.SLOT_MINUTES,
  });
  if (busy) {
    await ctx.reply(
      `⚠️ На это время уже записан ${busy.client_name}` +
        `${busy.master ? ` к мастеру ${busy.master}` : ''}.\n` +
        'Если это не помеха — напишите время чуть иначе, я запишу.',
      mainMenu
    );
    return true;
  }

  const appointment = await createAppointment({
    clientName: parsed.clientName,
    service: parsed.service,
    master: parsed.master,
    startsAt: parsed.when,
    source: 'telegram',
    note: parsed.note,
  });

  await ctx.reply(
    `✅ Записал: ${appointment.client_name}, ${salon.formatWhen(new Date(appointment.starts_at))}` +
      `${appointment.service ? `\nУслуга: ${appointment.service}` : ''}` +
      `${appointment.master ? `\nМастер: ${appointment.master}` : ''}`,
    mainMenu
  );
  return true;
}

if (SALON_MODE) {
  bot.command('today', replyToday);
  bot.command('records', replyUpcoming);
  bot.hears(MENU_TODAY, replyToday);
  bot.hears(MENU_UPCOMING, replyUpcoming);
}

bot.command('list', replyProductList);
bot.command('stats', replyStockSummary);
bot.command('help', (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.command('bulk', (ctx) => ctx.scene.enter('bulk-add'));

bot.hears(MENU_ADD, (ctx) => ctx.scene.enter('add-product'));
bot.hears(MENU_BULK, (ctx) => ctx.scene.enter('bulk-add'));
bot.hears(MENU_LIST, replyProductList);
bot.hears(MENU_STATS, replyStockSummary);
bot.hears(MENU_HELP, (ctx) => ctx.reply(HELP_TEXT, mainMenu));

bot.command('delete', async (ctx) => {
  const id = Number(ctx.message.text.split(' ')[1]);
  if (!id) {
    await ctx.reply('Использование: /delete <id>, либо нажмите «🗑 Удалить товар» в /list');
    return;
  }
  await deleteProduct(id);
  await ctx.reply(`Товар #${id} удалён.`);
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
    await ctx.reply('Товаров нет.');
    return;
  }
  await ctx.reply(
    'Какой товар удалить?',
    Markup.inlineKeyboard(
      products.map((p) => [Markup.button.callback(`${p.name} (${p.quantity ?? 0} шт.)`, `del:${p.id}`)])
    )
  );
});

bot.action(/^del:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  const product = await getProduct(id);
  await ctx.reply(
    `Удалить «${product.name}» (остаток ${product.quantity ?? 0})?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Да, удалить', `delyes:${id}`), Markup.button.callback('❌ Отмена', 'cancel')],
    ])
  );
});

bot.action(/^delyes:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = Number(ctx.match[1]);
  await deleteProduct(id);
  await ctx.editMessageText(`Товар #${id} удалён.`);
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
  // В салоне сообщение сначала проверяем на запись: «запиши Азамата на 15:00» —
  // это клиент, а не приход товара. Если про запись речи нет, разбираем как
  // раньше: у салона тот же каталог, только в нём услуги и цены.
  if (SALON_MODE && (await handleOwnerBooking(ctx, text))) return;

  const catalog = await getProductNames();
  const actions = await parseStockMessage(text, catalog);
  await applyActionsAndReply(
    ctx,
    actions,
    SALON_MODE
      ? 'Не смог понять. Для записи напишите «запиши Азамата завтра в 15:00 на стрижку», ' +
          'для цены — «стрижка мужская 500», или нажмите «ℹ️ Что я умею».'
      : 'Не смог понять, что нужно сделать. Попробуйте, например: «приехало 10 пачек сухарей» ' +
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
    const file = ctx.message.voice || ctx.message.audio;
    const link = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(link.href);
    const buffer = Buffer.from(await response.arrayBuffer());

    const text = await transcribeVoice(buffer);
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

function launchAdminBot() {
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
  // bot.launch() не резолвится, пока бот работает, поэтому не ждём его здесь.
  bot.launch().catch((err) => console.error('Не удалось запустить Telegram-бота:', err));
  console.log('Telegram-админка запущена.');
}

// Запуск напрямую (npm run start:admin) — стартуем сразу; при импорте из server.js
// запуском управляет вызывающий.
if (require.main === module) {
  launchAdminBot();
}

// renderToday/renderUpcoming наружу — это готовые экраны записей, их удобно
// проверять отдельно от Telegram и переиспользовать в сводках.
module.exports = { launchAdminBot, renderToday, renderUpcoming };
