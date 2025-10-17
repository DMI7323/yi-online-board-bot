import { getSheetData } from './utils/sheets.js'; 
import cron from 'node-cron';
import { Telegraf, Markup, session } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

// ── Безопасные проверки .env
const REQ_VARS = ['BOT_TOKEN', 'GOOGLE_PROJECT_ID', 'GOOGLE_PRIVATE_KEY', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_SHEET_ID'];
const missing = REQ_VARS.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length) {
  console.error(`❌ В .env отсутствуют: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('BOT_TOKEN:', process.env.BOT_TOKEN ? '✅ знайдено' : '❌ немає');
const bot = new Telegraf(process.env.BOT_TOKEN);

// ── Сессия для хранения выбранного города и пагинации
bot.use(session());

// ── Утилиты дат
function parseDate(d) {
  // ожидаем строки вида "01.11.2025" или "01.11"
  if (!d) return null;
  const parts = `${d}`.trim().split('.');
  if (parts.length < 2) return null;
  const now = new Date();
  let [dd, mm, yyyy] = parts;
  const day = Number(dd);
  const month = Number(mm) - 1;
  const year = parts[2] ? Number(yyyy) : now.getFullYear();
  const date = new Date(year, month, day);
  // если дата уже прошла, а год не указан — считаем следующий год (на случай планирования)
  if (!parts[2] && date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    return new Date(now.getFullYear() + 1, month, day);
  }
  return date;
}

function formatDate(d) {
  if (!(d instanceof Date)) return '-';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── Форматирование карточек курсов
function courseToHtml(row) {
  // Ожидаем: [groupId, city, course, start, end, instructor, price]
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

// ── Главная клавиатура
const mainKb = Markup.keyboard([
  ['📅 Розклад курсів', '📍 Обрати місто'],
  ['ℹ️ Допомога'],
]).resize();

// ── /start
bot.start((ctx) => {
  ctx.session.city = ctx.session.city || 'Усі';
  ctx.reply(
    `👋 Привіт, ${ctx.from.first_name}!\n\nЯ бот розкладу школи 💅\nОбери, що тебе цікавить 👇`,
    mainKb
  );
});

// ── Выбор города
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

// ── Показ расписания с учётом города и будущих дат
bot.hears('📅 Розклад курсів', async (ctx) => {
  try {
    const rows = await getSheetData('ГРУППЫ!A2:H'); // [id, city, course, start, end, instructor, price, ...]
    if (!rows || rows.length === 0) return ctx.reply('Наразі немає запланованих курсів.');

    const today = new Date();
    const filtered = rows
      .map((r) => ({ r, s: parseDate(r[3]) })) // r[3] = start
      .filter(({ s }) => s && s >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
      .filter(({ r }) => (ctx.session.city && ctx.session.city !== 'Усі' ? `${r[1]}`.trim() === ctx.session.city : true))
      .sort((a, b) => a.s - b.s)
      .map(({ r }) => r);

    if (filtered.length === 0) {
      return ctx.reply(`Нічого не знайдено для міста “${ctx.session.city || 'Усі'}”.`);
    }

    // пагинация по 6 курсов за сообщение
    const chunks = chunk(filtered, 6);
    for (const part of chunks) {
      const msg =
        '📆 <b>Найближчі курси:</b>\n\n' +
        part.map((row) => courseToHtml(row)).join('\n\n');
      await ctx.replyWithHTML(msg);
    }
  } catch (err) {
    console.error('❌ Розклад помилка:', err);
    await ctx.reply('⚠️ Помилка під час отримання розкладу.');
    if (process.env.ADMIN_CHAT_ID) {
      await bot.telegram.sendMessage(
        process.env.ADMIN_CHAT_ID,
        `🚨 Помилка "Розклад": ${err.message || err}`
      );
    }
  }
});

// ── Детали по ID группы: /id 12345
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

// ── Помощь
bot.hears('ℹ️ Допомога', (ctx) => {
  ctx.replyWithHTML(
    '🧭 Я допоможу знайти актуальний розклад.\n\n' +
    '• Обери <b>📍 Обрати місто</b>\n' +
    '• Натисни <b>📅 Розклад курсів</b>\n' +
    '• Або надішли команду <code>/id GROUP_ID</code> щоб отримати деталі по групі.'
  );
});

// ── Webhook (если задан), иначе polling
async function launch() {
  const url = process.env.BOT_WEBHOOK_URL?.trim();
  if (url) {
    const path = '/tg-webhook';
    await bot.telegram.setWebhook(url + path);
    console.log(`🌐 Webhook режим: ${url + path}`);
    // если у тебя express/fastify нет, Telegraf сам поднимет http-сервер
    bot.startWebhook(path, undefined, process.env.PORT || 3000);
  } else {
    await bot.launch();
    console.log('🤖 Бот запущено (polling)');
  }
}

launch().catch((e) => {
  console.error('❌ Помилка запуску бота:', e);
  process.exit(1);
});

// ── Автоматичне щоденне нагадування про курси (завтра + через 2 дні)
cron.schedule('0 8 * * *', async () => {
  console.log('🕗 Перевіряю групи, що стартують завтра або через 2 дні...');
  try {
    const rows = await getSheetData('ГРУППЫ!A2:H');
    const today = new Date();

    const targets = [1, 2]; // завтра і через 2 дні
    const upcoming = [];

    for (const r of rows) {
      const start = new Date(r[3].split('.').reverse().join('-')); // формат дати "dd.mm.yyyy"
      const diffDays = Math.floor((start - today) / 86400000);
      if (targets.includes(diffDays)) upcoming.push(r);
    }

    if (upcoming.length === 0) {
      console.log('✅ Немає груп, що стартують найближчими днями.');
      return;
    }

    for (const r of upcoming) {
      const [groupId, city, course, start, end, instructor] = r;
      const diff = Math.floor((new Date(start.split('.').reverse().join('-')) - today) / 86400000);
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
