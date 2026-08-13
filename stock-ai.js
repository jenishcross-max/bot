const Groq = require('groq-sdk');
const { toFile } = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TEXT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
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

function safeParseActions(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.actions) ? parsed.actions : [];
  } catch {
    return [];
  }
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
  });

  return safeParseActions(completion.choices[0]?.message?.content || '{}');
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

module.exports = { parseStockMessage, parseInvoiceImage, transcribeVoice };
