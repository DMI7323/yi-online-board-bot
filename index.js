import { getSheetData } from './utils/sheets.js';
import cron from 'node-cron';
import { Telegraf, Markup, session } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

// === Перевірка обов’язкових змінних .env ===
const REQ_VARS = [
  'BOT_TOKEN',
  'GOOGLE_PROJECT_ID',
  'GOOGLE_PRIVATE_KEY',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_SHEET_ID'
];
const missing = REQ_VARS.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length) {
  console.error(`❌ В .env відсутні: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ знайдено' : '❌ немає');

// === Ініціалізація Telegram-бота ===
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// === Утиліти для дат ===
function parseDate(d) {
  if (!d) return null;
  const parts = `${d}`.trim().split('.');
  if (parts.length < 2) return null;
  const now = new Date();
  const [dd, mm, yyyy] = [Number(parts[0]), Number(parts[1]), parts[2] ? Number(parts[2]) : now.getFullYear()];
  const date = new Date(yyyy, mm - 1, dd);
  if (!parts[2] && date < now) return new Date(now.getFullYear() + 1, mm - 1, dd);
  return date;
}

function formatDate(d) {
  if (!(d instanceof Date)) return '-';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// === Форматування картки курсу ===
function courseToHtml(row = []) {
  if (!Array.isArray(row) || row.length < 3) return '⚠️ Некоректний рядок у таблиці.';
  const [groupId, city, course, start, end, instructor, price] = row;
  const s = parseDate(start);
  const e = parseDate(end);
  return (
    `🏙 <b>${city || '-'}</b>\n` +
    `🎓 ${course || '-'}\n` +
    `👩‍🏫 ${instructor || '-'}\n` +
    `💰 ${price || '-'}\n` +
    `📅 ${formatDate(s)} — ${formatDate(e)}\n` +
    `🆔 <code>${groupId || '-'}</code>`
  );
}

// === Головне меню ===
const mainKb = Markup.keyboard([
  ['📅 Розклад курсів', '📍 Обрати місто'],
  ['ℹ️ Допомога']
]).resize();

// === Команда /start ===
bot.start((ctx) => {
  ctx.session.city = ctx.session.city || 'Усі';
  ctx.reply(
    `👋 Привіт, ${ctx.from.first_name}!\n\nЯ бот розкладу школи 💅\nОбери, що тебе цікавить 👇`,
    mainKb
  );
});

// === Вибір міста ===
const cities = ['Усі', 'Одеса', 'Миколаїв'];
bot.hears('📍 Обрати місто', (ctx) => {
  const kb = Markup.inlineKeyboard(
    cities.map((c) => Markup.button.callback(ctx.session.city === c ? `✅ ${c}` : c, `CITY_${c}`)),
    { columns: 3 }
  );
  ctx.reply('Вибери місто:', kb);
});

cities.forEach((c) => {
  bot.action(`CITY_${c}`, async (ctx) => {
    ctx.session.city = c;
    await ctx.answerCbQuery(`Місто: ${c}`);
    await ctx.editMessageText(`Обрано місто: ${c}`);
  });
});

// === Розклад курсів ===
bot.hears('📅 Розклад курсів', async (ctx) => {
  try {
    const rows = await getSheetData('ГРУППЫ!A2:H');
    if (!rows || !rows.length) return ctx.reply('Наразі немає запланованих курсів.');

    // фільтруємо тільки повні рядки
    const validRows = rows.filter((r) => Array.isArray(r) && r.length >= 7 && r[3]);

    const today = new Date();
    const filtered = validRows
      .map((r) => ({ r, s: parseDate(r[3]) }))
      .filter(({ s }) => s && s >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
      .filter(({ r }) => (ctx.session.city && ctx.session.city !== 'Усі' ? `${r[1]}`.trim() === ctx.session.city : true))
      .sort((a, b) => a.s - b.s)
      .map(({ r }) => r);

    if (!filtered.length) {
      return ctx.reply(`Нічого не знайдено для міста “${ctx.session.city || 'Усі'}”.`);
    }

    const chunks = chunk(filtered, 6);
    for (const part of chunks) {
      const msg = '📆 <b>Найближчі курси:</b>\n\n' + part.map((row) => courseToHtml(row)).join('\n\n');
      await ctx.replyWithHTML(msg);
    }
  } catch (err) {
    console.error('❌ Розклад помилка:', err);
    await ctx.reply('⚠️ Помилка під час отримання розкладу.');
    if (process.env.ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, `🚨 Помилка "Розклад": ${err.message || err}`);
    }
  }
});

// === Деталі по ID ===
bot.hears(/^(\/id|id)\s+(.+)/i, async (ctx) => {
  const groupId = ctx.match[2].trim();
  try {
    const rows = await getSheetData('ГРУППЫ!A2:H');
    const row = rows.find((r) => `${r[0]}`.trim() === groupId);
    if (!row) return ctx.reply('Групу з таким ID не знайдено.');
    await ctx.replyWithHTML(courseToHtml(row));
  } catch (err) {
    console.error('❌ Пошук за ID помилка:', err);
    await ctx.reply('⚠️ Помилка при пошуку групи.');
  }
});

// === Допомога ===
bot.hears('ℹ️ Допомога', (ctx) => {
  ctx.replyWithHTML(
    '🧭 Я допоможу знайти актуальний розклад.\n\n' +
    '• Обери <b>📍 Обрати місто</b>\n' +
    '• Натисни <b>📅 Розклад курсів</b>\n' +
    '• Або напиши <code>/id GROUP_ID</code> щоб отримати деталі по групі.'
  );
});

// === Запуск ===
async function launch() {
  try {
    const url = process.env.BOT_WEBHOOK_URL?.trim();
    if (url) {
      const path = '/tg-webhook';
      await bot.telegram.setWebhook(url + path);
      console.log(`🌐 Webhook режим: ${url + path}`);
      bot.startWebhook(path, undefined, process.env.PORT || 3000);
    } else {
      await bot.launch();
      console.log('🤖 Бот запущено (polling)');
    }
  } catch (err) {
    console.error('❌ Помилка запуску бота:', err);
    process.exit(1);
  }
}

launch();

// === Автоматичне нагадування (щодня о 8:00) ===
cron.schedule('0 8 * * *', async () => {
  console.log('🕗 Перевіряю групи, що стартують завтра або через 2 дні...');
  try {
    const rows = await getSheetData('ГРУППЫ!A2:H');
    const validRows = rows.filter((r) => Array.isArray(r) && r.length >= 5 && r[3]);
    const today = new Date();
    const targets = [1, 2];
    const upcoming = [];

    for (const r of validRows) {
      const start = parseDate(r[3]);
      if (!start) continue;
      const diffDays = Math.floor((start - today) / 86400000);
      if (targets.includes(diffDays)) upcoming.push(r);
    }

    if (!upcoming.length) {
      console.log('✅ Немає груп, що стартують найближчими днями.');
      return;
    }

    for (const r of upcoming) {
      const [groupId, city, course, start, end, instructor] = r;
      const diff = Math.floor((parseDate(start) - today) / 86400000);
      const when = diff === 1 ? '🚀 Завтра' : '⏳ Через 2 дні';
      const msg =
        `${when} стартує курс!\n\n` +
        `🏙 <b>${city}</b>\n🎓 ${course}\n👩‍🏫 ${instructor}\n📅 ${start} — ${end}\n🆔 <code>${groupId}</code>`;

      await bot.telegram.sendMessage(process.env.ADMIN_CHAT_ID, msg, { parse_mode: 'HTML' });
    }

    console.log(`✅ Надіслано ${upcoming.length} повідомлень.`);
  } catch (err) {
    console.error('❌ Помилка автонагадування:', err);
  }
});
import http from 'http';
const PORT = process.env.PORT || 10000;

// створюємо простий сервер, щоб Render бачив відкритий порт
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running\n');
  })
  .listen(PORT, () => console.log(`🌐 Port ${PORT} opened for Render`));
  await bot.telegram.sendMessage(process.env.DEFAULT_CHAT_ID, '✅ Бот бачить групу і готовий працювати!');

