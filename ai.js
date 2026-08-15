const Groq = require('groq-sdk');
const { notifyAdmins } = require('./notify');
const haggle = require('./haggle');
const { describeProductPhoto } = require('./stock-ai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Режим магазина: подмешивает релевантные товары из Supabase в контекст ответа (RAG).
const SHOP_MODE = process.env.SHOP_MODE === 'true';
// Режим салона: то же самое плюс запись клиентов на время.
const SALON_MODE = process.env.SALON_MODE === 'true';
// Каталог нужен обоим: у магазина это товары, у салона — услуги с ценами.
const CATALOG_MODE = SHOP_MODE || SALON_MODE;
const {
  searchProducts,
  getProductNames,
  createAppointment,
  findClientAppointments,
  findBusyAppointment,
  setAppointmentStatus,
} = CATALOG_MODE ? require('./db') : {};
const salon = SALON_MODE ? require('./salon') : null;

const SHOP_NAME = process.env.SHOP_NAME || 'магазин';
const SHOP_ADDRESS = process.env.SHOP_ADDRESS || '';
const SHOP_PHONE = process.env.SHOP_PHONE || '';
const SHOP_HOURS = process.env.SHOP_HOURS || '';
const SHOP_DELIVERY = process.env.SHOP_DELIVERY || '';
// Валюта в ответах клиентам. Меняется одной переменной — «тенге», «руб» и т.д.
const CURRENCY = process.env.CURRENCY || 'сом';

const DEFAULT_SHOP_PROMPT =
  `Ты — вежливый продавец-консультант магазина «${SHOP_NAME}», отвечаешь клиентам в WhatsApp. ` +
  'Отвечай кратко (2-4 предложения), на русском языке, дружелюбно и по делу. ' +
  'Говори о наличии и ценах только по данным каталога, которые тебе передали. ' +
  'Если товара нет — честно скажи об этом и предложи то, что есть. ' +
  'Если клиент хочет оформить заказ, приехать или поговорить с человеком — скажи, ' +
  'что передаёшь заявку менеджеру, и он свяжется с клиентом. ' +
  // Описание фотографии подставляется в сообщение клиента автоматически.
  // Без этой строчки бот отвечает «на фото я вижу...» и звучит как робот.
  'Если в сообщении клиента есть пометка в квадратных скобках о присланном фото — ' +
  'это автоматическое описание снимка. Отвечай по нему как продавец, посмотревший фото, ' +
  'но саму пометку не пересказывай. Если по фото не понять, что за товар, — ' +
  'спроси у клиента, а не выдумывай модель и размер.';

// Салону продавать нечего — ему нужно занять время в кресле. Поэтому и роль
// другая: администратор, который не столько консультирует, сколько записывает.
const SALON_NAME = process.env.SALON_NAME || SHOP_NAME;

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

// У каждого режима своя роль, поэтому и промпт отдельный: так можно переключать
// режимы одной переменной, не переписывая SYSTEM_PROMPT.
function pickSystemPrompt() {
  if (SALON_MODE) return process.env.SALON_SYSTEM_PROMPT || DEFAULT_SALON_PROMPT;
  if (SHOP_MODE) return process.env.SHOP_SYSTEM_PROMPT || DEFAULT_SHOP_PROMPT;
  return (
    process.env.SYSTEM_PROMPT ||
    'Ты — дружелюбный ассистент в WhatsApp. Отвечай кратко и по делу на русском языке.'
  );
}

const SYSTEM_PROMPT = pickSystemPrompt();

// Справка о магазине идёт отдельным системным сообщением: адрес и часы работы бот
// иначе выдумывает, а так отвечает фактами владельца.
function buildShopInfo() {
  const lines = [];
  if (SHOP_ADDRESS) lines.push(`Адрес: ${SHOP_ADDRESS}`);
  if (SHOP_HOURS) lines.push(`Часы работы: ${SHOP_HOURS}`);
  if (SHOP_PHONE) lines.push(`Телефон: ${SHOP_PHONE}`);
  if (SHOP_DELIVERY) lines.push(`Доставка: ${SHOP_DELIVERY}`);
  if (lines.length === 0) return null;
  const what = SALON_MODE ? 'о салоне' : 'о магазине';
  return `Информация ${what} (отвечай по ней, ничего не добавляй от себя):\n${lines.join('\n')}`;
}

const SHOP_INFO = buildShopInfo();

function buildManagerText() {
  if (process.env.MANAGER_CONTACT_TEXT) return process.env.MANAGER_CONTACT_TEXT;

  const lines = ['Конечно! Передал вашу заявку менеджеру — он свяжется с вами в ближайшее время.'];
  if (SHOP_PHONE) lines.push(`Можете позвонить сами: ${SHOP_PHONE}`);
  if (SHOP_ADDRESS) lines.push(`Наш адрес: ${SHOP_ADDRESS}`);
  if (SHOP_HOURS) lines.push(`Работаем: ${SHOP_HOURS}`);
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

function formatProductsContext(products) {
  if (!products || products.length === 0) {
    return 'В каталоге сейчас нет подходящих товаров.';
  }
  return products
    .map((p) => {
      const price = p.price != null ? `${p.price} ${CURRENCY}` : 'цена не указана';
      const stock = typeof p.quantity === 'number' ? `, в наличии: ${p.quantity} шт.` : '';
      return `- ${p.name}: ${price}${p.category ? ` [${p.category}]` : ''}${p.description ? ` — ${p.description}` : ''}${stock}`;
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

function notifyOwnerAboutBooking(appointment, phone) {
  const lines = [
    '🗓 Новая запись!',
    '',
    `Клиент: ${appointment.client_name}`,
    `Телефон: ${phone ? `+${String(phone).replace(/\D/g, '')}` : 'номер скрыт'}`,
    `Когда: ${salon.formatWhen(new Date(appointment.starts_at))}`,
  ];
  if (appointment.service) lines.push(`Услуга: ${appointment.service}`);
  if (appointment.master) lines.push(`Мастер: ${appointment.master}`);
  if (appointment.note) lines.push(`Пометка: ${appointment.note}`);
  notifyAdmins(lines.join('\n')).catch((err) =>
    console.error('Не удалось сообщить владельцу о записи:', err)
  );
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
    services = await getProductNames();
  } catch (err) {
    console.error('Не удалось получить список услуг:', err.message);
  }

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
  if (parsed.intent === 'none' && !pending) return null;

  // Собираем запись из того, что уже знали, и того, что клиент сказал сейчас.
  const draft = {
    clientName: parsed.clientName || pending?.clientName || null,
    service: parsed.service || pending?.service || null,
    master: parsed.master || pending?.master || null,
    when: parsed.when || pending?.when || null,
    day: parsed.day || pending?.day || null,
    note: parsed.note || pending?.note || null,
  };

  if (!draft.when) {
    savePending(chatId, draft);
    // День клиент уже назвал — переспрашиваем только час, иначе разговор
    // начинается с нуля и это раздражает.
    if (draft.day) {
      return `Записываю на ${salon.formatDay(draft.day)}. Во сколько вам удобно? Работаем ${salon.workHoursText()}.`;
    }
    return `Конечно, запишу вас! Работаем ${salon.workHoursText()}. На какой день и время вам удобно?`;
  }

  const check = salon.checkWhen(draft.when);
  if (!check.ok) {
    // Время уже прошло или салон закрыт — записать нельзя, но и терять клиента
    // нельзя: спрашиваем другое время, а не отвечаем «не могу».
    savePending(chatId, { ...draft, when: null });
    if (check.reason === 'no_clock') {
      return `Хорошо! А во сколько вам удобно? Работаем ${salon.workHoursText()}.`;
    }
    if (check.reason === 'closed') {
      return `В это время мы уже закрыты — работаем ${salon.workHoursText()}. Подберём другое время?`;
    }
    if (check.reason === 'past') {
      return 'Это время уже прошло. На какой ближайший день вас записать?';
    }
    return 'Не поняла время записи. Напишите, пожалуйста, день и час — например «завтра в 15:00».';
  }

  if (!draft.clientName) {
    savePending(chatId, draft);
    return `Записываю на ${salon.formatWhen(draft.when)}. Как вас записать — подскажите имя?`;
  }

  try {
    const busy = await findBusyAppointment(draft.when, {
      master: draft.master,
      durationMinutes: salon.SLOT_MINUTES,
    });
    if (busy) {
      savePending(chatId, { ...draft, when: null });
      const who = draft.master ? `У ${draft.master} это` : 'Это';
      return `${who} время уже занято. Подскажите другое — посмотрю, что свободно.`;
    }

    const appointment = await createAppointment({
      clientName: draft.clientName,
      phone,
      chatId,
      service: draft.service,
      master: draft.master,
      startsAt: draft.when,
      source: 'whatsapp',
      note: draft.note,
    });

    pendingBookings.delete(chatId);
    notifyOwnerAboutBooking(appointment, phone);

    const lines = [`Готово, ${draft.clientName}! Записала вас: ${bookingSummary(appointment)}.`];
    if (SHOP_ADDRESS) lines.push(`Адрес: ${SHOP_ADDRESS}`);
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
    return await describeProductPhoto(photo.data.toString('base64'), photo.mimeType, caption);
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
  // время, а не про менеджера, но в MANAGER_INTENT такие слова тоже попадают.
  if (SALON_MODE) {
    const booking = await handleBooking(chatId, userMessage, history, phone);
    if (booking) {
      history.push({ role: 'assistant', content: booking });
      return booking;
    }
  }

  // В заявку владельцу уходит entry, а не userMessage: если клиент прислал
  // только фото без подписи, в уведомлении иначе будет пустая строка вместо
  // «на фото такая-то футболка».
  if (CATALOG_MODE && MANAGER_INTENT.test(userMessage)) {
    return handleManagerRequest(chatId, entry, history, phone);
  }

  // Проверку на менеджера оставляем выше: «беру, оформляйте» после торга — это
  // заявка, и владелец должен получить её, а не очередную шутку про ценник.
  const haggling = haggle.detect(chatId, userMessage);

  const systemMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

  if (CATALOG_MODE) {
    if (SHOP_INFO) {
      systemMessages.push({ role: 'system', content: SHOP_INFO });
    }
    try {
      // По фото ищем словами, которые подобрала модель зрения: подпись вроде
      // «есть такая?» для поиска бесполезна, а «футболка оверсайз белая» — нет.
      const products = await searchProducts((seen && seen.query) || userMessage);
      systemMessages.push({
        role: 'system',
        content:
          'Вот товары из каталога магазина, релевантные запросу клиента. Используй только эти данные, ' +
          'ничего не выдумывай про товары, которых здесь нет:\n' + formatProductsContext(products),
      });
    } catch (err) {
      console.error('Не удалось получить товары из базы:', err);
    }
  }

  // Персона торгаша идёт последней системной инструкцией: поставленная раньше,
  // она проигрывает промпту каталога («отвечай кратко и по делу»), и вместо шутки
  // клиент получает сухое «цену снизить не могу».
  if (haggling) systemMessages.push({ role: 'system', content: haggling.prompt });

  const messages = [
    ...systemMessages,
    ...history.slice(-MAX_HISTORY_MESSAGES),
  ];

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: MODEL,
      messages,
      // Торгашу нужна отсебятина: на 0.7 шутки быстро начинают повторяться.
      temperature: haggling ? 0.95 : 0.7,
      max_tokens: 800,
    });
  } catch (err) {
    // В торге молчание хуже заготовки: клиент ждёт ответной шутки, а не тишины.
    if (!haggling) throw err;
    console.error('Groq недоступен, отвечаю заготовкой торгаша:', err.message);
    const canned = haggle.fallback(haggling);
    history.push({ role: 'assistant', content: canned });
    return canned + haggle.badge(haggling);
  }

  let reply = completion.choices[0]?.message?.content?.trim() || 'Извините, не смог сформировать ответ.';

  if (haggling) {
    // Последний рубеж: что бы модель ни насочиняла, скидка до клиента не доедет.
    reply = haggle.guard(reply, haggling);
  }

  // Бот пообещал клиенту передать заявку — значит, владелец обязан её получить,
  // даже если вопрос не попал в MANAGER_INTENT. Проверяем после guard: до него
  // текст ответа ещё может измениться.
  if (CATALOG_MODE && MANAGER_PROMISE.test(reply)) {
    notifyManager(chatId, entry, history, phone);
  }

  history.push({ role: 'assistant', content: reply });

  // Игровую строчку в историю не кладём — модели она только мешает.
  return haggling ? reply + haggle.badge(haggling) : reply;
}

function resetHistory(chatId) {
  conversations.delete(chatId);
  haggle.reset(chatId);
  lastNotifiedAt.delete(chatId);
  pendingBookings.delete(chatId);
}

module.exports = { getAIReply, resetHistory };
