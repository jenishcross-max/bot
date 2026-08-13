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
} = require('./db');
const { parseStockMessage, parseInvoiceImage, transcribeVoice } = require('./stock-ai');

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

const MENU_ADD = '➕ Добавить товар';
const MENU_BULK = '⚡ Быстрое заполнение';
const MENU_LIST = '📋 Список товаров';
const MENU_STATS = '📊 Остатки склада';
const MENU_HELP = 'ℹ️ Что я умею';

const mainMenu = Markup.keyboard([
  [MENU_ADD, MENU_BULK],
  [MENU_LIST, MENU_STATS],
  [MENU_HELP],
]).resize();

bot.use((ctx, next) => {
  const userId = String(ctx.from?.id || '');
  if (!ADMIN_IDS.includes(userId)) {
    return ctx.reply('Доступ запрещён. Этот бот только для владельца магазина.');
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

const HELP_TEXT =
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

bot.start((ctx) => ctx.reply(`Админ-бот магазина.\n\n${HELP_TEXT}`, mainMenu));

bot.command('add', (ctx) => ctx.scene.enter('add-product'));

function productLine(p) {
  return (
    `#${p.id} ${p.name} — ${p.price ?? '—'}${p.category ? ` [${p.category}]` : ''}` +
    `, остаток: ${p.quantity ?? 0}${p.in_stock ? '' : ' (нет в наличии)'}`
  );
}

async function replyProductList(ctx) {
  const products = await listProducts({ limit: 30 });
  if (products.length === 0) {
    await ctx.reply('Товаров пока нет. Нажмите «➕ Добавить товар».', mainMenu);
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

module.exports = { launchAdminBot };
