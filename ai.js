const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'Ты — дружелюбный ассистент в WhatsApp. Отвечай кратко и по делу на русском языке.';

// История диалога на каждый чат: chatId -> [{role, content}, ...]
const conversations = new Map();
const MAX_HISTORY_MESSAGES = 20;

function getHistory(chatId) {
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  return conversations.get(chatId);
}

async function getAIReply(chatId, userMessage) {
  const history = getHistory(chatId);
  history.push({ role: 'user', content: userMessage });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-MAX_HISTORY_MESSAGES),
  ];

  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 800,
  });

  const reply = completion.choices[0]?.message?.content?.trim() || 'Извините, не смог сформировать ответ.';
  history.push({ role: 'assistant', content: reply });

  return reply;
}

function resetHistory(chatId) {
  conversations.delete(chatId);
}

module.exports = { getAIReply, resetHistory };
