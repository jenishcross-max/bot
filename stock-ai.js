const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TEXT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// Модель, умеющая смотреть на картинки. Прежняя llama-4-scout из Groq пропала —
// запросы к ней возвращали 404, и распознавание фото молча переставало работать.
// Если и эта исчезнет, список доступных моделей: https://console.groq.com/docs/models
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const AUDIO_MODEL = process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3';

const ACTIONS_SYSTEM_PROMPT = `Ты — помощник кладовщика магазина. Пользователь пишет сообщения о поступлении, продаже, изменении или наличии товаров на русском языке.
Разбери сообщение и верни ТОЛЬКО JSON без пояснений, в формате:
{"actions": [{
  "type": "restock" | "sale" | "out_of_stock" | "update" | "delete" | "query",
  "name": "название товара для поиска в базе",
  "quantity": число или null,
  "new_name": "новое название" или null,
  "price": число или null,
  "set_quantity": число или null
}]}

Типы действий:
- "приехали/привезли/поступило/пришло N X" -> "restock", quantity N
- "продано/продали/купили N X" -> "sale", quantity N
- "закончились/нет в наличии/кончились X" -> "out_of_stock"
- "переименуй/перезапиши название X в Y", "у X цена N", "исправь остаток X на N" -> "update"
  (в одном "update" можно указать сразу new_name, price и set_quantity)
- "удали товар X", "убери X из базы" -> "delete"
- "сколько X осталось?", "есть ли X?", "какая цена у X?" -> "query"

Правила:
- Если действий несколько в одном сообщении — верни несколько actions.
- Если не понимаешь, о каком товаре речь — не включай эту позицию.
- Не придумывай товары, которых нет в тексте сообщения.`;

// Каталог в промпте нужен, чтобы ИИ сопоставлял «сухарики» с уже существующим
// «Пачка сухариков», а не заводил дубль под новым названием.
function buildCatalogHint(catalogNames) {
  if (!catalogNames || catalogNames.length === 0) {
    return '\n\nВ базе пока нет товаров — любое поступление создаёт новый товар.';
  }
  return (
    '\n\nТовары, уже существующие в базе:\n' +
    catalogNames.map((n) => `- ${n}`).join('\n') +
    '\n\nВАЖНО: если товар из сообщения соответствует одному из них (даже если пользователь ' +
    'написал его в другом падеже, числе или сокращённо) — в поле "name" укажи ТОЧНО название ' +
    'из этого списка. Новое название придумывай только для действительно нового товара.'
  );
}

// Рассуждающие модели (qwen и подобные) пишут ход мыслей прямо в ответ, а иногда
// добавляют пояснение до или после JSON. Поэтому вырезаем размышления и берём
// то, что лежит между первой «{» и последней «}» — на голом JSON.parse это
// падало и выглядело как «модель ничего не распознала».
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

function safeParseActions(raw) {
  const parsed = extractJson(raw);
  return parsed && Array.isArray(parsed.actions) ? parsed.actions : [];
}

async function parseStockMessage(text, catalogNames = []) {
  const completion = await groq.chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: ACTIONS_SYSTEM_PROMPT + buildCatalogHint(catalogNames) },
      { role: 'user', content: text },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return safeParseActions(completion.choices[0]?.message?.content || '{}');
}

const INVOICE_SYSTEM_PROMPT = `Ты распознаёшь товарную накладную на фото. Извлеки список товаров и их количество.
Верни ТОЛЬКО JSON без пояснений, в формате:
{"actions": [{"type": "restock", "name": "название товара", "quantity": число, "price": цена за единицу или null}]}
Если количество для какой-то позиции не указано или неразборчиво — не включай эту позицию.`;

async function parseInvoiceImage(base64Image, catalogNames = [], mimeType = 'image/jpeg') {
  const completion = await groq.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: INVOICE_SYSTEM_PROMPT + buildCatalogHint(catalogNames) },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    // Рассуждающая модель сначала думает, потом отвечает. Без запаса по длине
    // ответ обрывается на середине размышлений и JSON до нас не доезжает.
    max_completion_tokens: 2000,
  });

  return safeParseActions(completion.choices[0]?.message?.content || '{}');
}

// Фото товара от клиента в WhatsApp. Отдельно от накладной: там нужен список
// позиций с количествами, а здесь один предмет — что это и по каким словам
// искать его в каталоге. Клиенту проще прислать фотографию, чем вспоминать,
// как называется деталь.
const PHOTO_SYSTEM_PROMPT = `Ты смотришь на фото, которое клиент прислал в магазин. Опиши, что на нём.
Верни ТОЛЬКО JSON без пояснений, в формате:
{"description": "что видно: предмет, цвет, форма, надписи и модель, если читаются — одна-две фразы",
 "query": "2-4 слова для поиска этого товара в каталоге магазина"}

Правила:
- Пиши по-русски.
- Описывай только то, что действительно видно. Марку, модель и размер не выдумывай:
  если их не разобрать, так и не упоминай.
- Если на фото не товар (человек, документ, скриншот переписки, что-то неразборчивое) —
  оставь "query" пустой строкой, а в "description" честно напиши, что видно.`;

async function describeProductPhoto(base64Image, mimeType = 'image/jpeg', caption = '') {
  const completion = await groq.chat.completions.create({
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            // Подпись помогает модели: «есть такая футболка?» подсказывает,
            // что на фото важен предмет одежды, а не фон комнаты.
            text: PHOTO_SYSTEM_PROMPT + (caption ? `\n\nПодпись клиента к фото: «${caption}»` : ''),
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
        ],
      },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
    max_completion_tokens: 1200,
  });

  const parsed = extractJson(completion.choices[0]?.message?.content);
  const description = String((parsed && parsed.description) || '').trim();
  if (!description) return null;
  return { description, query: String((parsed && parsed.query) || '').trim() };
}

// Голосовое сообщение из Telegram (ogg/opus) -> текст, дальше разбирается как обычное сообщение.
async function transcribeVoice(buffer, filename = 'voice.ogg') {
  const transcription = await groq.audio.transcriptions.create({
    file: await toFile(buffer, filename),
    model: AUDIO_MODEL,
    language: 'ru',
  });

  return transcription.text?.trim() || '';
}

module.exports = { parseStockMessage, parseInvoiceImage, describeProductPhoto, transcribeVoice };
