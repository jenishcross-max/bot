const Groq = require('groq-sdk');
const { notifyAdmins } = require('./notify');
const haggle = require('./haggle');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Режим магазина: подмешивает релевантные товары из Supabase в контекст ответа (RAG).
const SHOP_MODE = process.env.SHOP_MODE === 'true';
const { searchProducts } = SHOP_MODE ? require('./db') : {};

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
  'что передаёшь заявку менеджеру, и он свяжется с клиентом.';

// В режиме магазина у бота другая роль, поэтому и промпт отдельный: так можно
// переключать режимы одним SHOP_MODE, не переписывая SYSTEM_PROMPT.
const SYSTEM_PROMPT = SHOP_MODE
  ? process.env.SHOP_SYSTEM_PROMPT || DEFAULT_SHOP_PROMPT
  : process.env.SYSTEM_PROMPT ||
    'Ты — дружелюбный ассистент в WhatsApp. Отвечай кратко и по делу на русском языке.';

// Справка о магазине идёт отдельным системным сообщением: адрес и часы работы бот
// иначе выдумывает, а так отвечает фактами владельца.
function buildShopInfo() {
  const lines = [];
  if (SHOP_ADDRESS) lines.push(`Адрес: ${SHOP_ADDRESS}`);
  if (SHOP_HOURS) lines.push(`Часы работы: ${SHOP_HOURS}`);
  if (SHOP_PHONE) lines.push(`Телефон: ${SHOP_PHONE}`);
  if (SHOP_DELIVERY) lines.push(`Доставка: ${SHOP_DELIVERY}`);
  if (lines.length === 0) return null;
  return (
    'Информация о магазине (отвечай по ней, ничего не добавляй от себя):\n' + lines.join('\n')
  );
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
function formatCustomer(chatId) {
  const digits = String(chatId || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : String(chatId || 'неизвестный номер');
}

async function handleManagerRequest(chatId, userMessage, history) {
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Клиент' : 'Бот'}: ${m.content}`)
    .join('\n');

  notifyAdmins(
    `🔔 Клиент просит менеджера!\n\n` +
      `Номер: ${formatCustomer(chatId)}\n` +
      `Сообщение: «${userMessage}»\n\n` +
      `Последние сообщения:\n${recent}`
  ).catch((err) => console.error('Не удалось уведомить владельца:', err));

  history.push({ role: 'assistant', content: MANAGER_TEXT });
  return MANAGER_TEXT;
}

async function getAIReply(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMessage });

  if (SHOP_MODE && MANAGER_INTENT.test(userMessage)) {
    return handleManagerRequest(chatId, userMessage, history);
  }

  // Проверку на менеджера оставляем выше: «беру, оформляйте» после торга — это
  // заявка, и владелец должен получить её, а не очередную шутку про ценник.
  const haggling = haggle.detect(chatId, userMessage);

  const systemMessages = [{ role: 'system', content: SYSTEM_PROMPT }];

  if (SHOP_MODE) {
    if (SHOP_INFO) {
      systemMessages.push({ role: 'system', content: SHOP_INFO });
    }
    try {
      const products = await searchProducts(userMessage);
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
    history.push({ role: 'assistant', content: reply });
    // Игровую строчку в историю не кладём — модели она только мешает.
    return reply + haggle.badge(haggling);
  }

  history.push({ role: 'assistant', content: reply });

  return reply;
}

function resetHistory(chatId) {
  conversations.delete(chatId);
  haggle.reset(chatId);
}

module.exports = { getAIReply, resetHistory };
