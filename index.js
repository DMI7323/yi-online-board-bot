import { Telegraf, Markup, session } from 'telegraf';
import dotenv from 'dotenv';
import express from 'express';
import { getSheetData } from './utils/sheets.js';

dotenv.config();

// === Перевірка токена ===
if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN відсутній у .env');
  process.exit(1);
}

// === Ініціалізація бота ===
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// === Express сервер для Render ===
const app = express();
app.get('/', (req, res) => res.send('✅ YI Courses Bot is alive'));
app.listen(process.env.PORT || 3000, () =>
  console.log(`🌐 Port ${process.env.PORT || 3000} bound for Render`)
);

// === Вимикаємо webhook (щоб уникнути 409 Conflict) ===
try {
  await bot.telegram.deleteWebhook();
  console.log('🔧 Webhook вимкнено — polling активний');
} catch (e) {
  console.warn('⚠️ Не вдалося вимкнути webhook:', e.message);
}

// === Команда /start ===
bot.start(async (ctx) => {
  ctx.session.city = ctx.session.city || 'Усі';
  await ctx.reply(
    `👋 Привіт, ${ctx.from.first_name}!\n\nЯ бот розкладу школи 💅\nОбери, що тебе цікавить 👇`,
    Markup.keyboard([['📅 Розклад курсів', '📍 Обрати місто'], ['ℹ️ Допомога']]).resize()
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
    if (!rows?.length) return ctx.reply('Наразі немає запланованих курсів.');

    const today = new Date();
    const validRows = rows.filter((r) => Array.isArray(r) && r.length >= 7 && r[3]);
    const filtered = validRows
      .map((r) => ({ r, s: parseDate(r[3]) }))
      .filter(({ s }) => s && s >= new Date(today.getFullYear(), today.getMonth(), today.getDate()))
      .filter(({ r }) => (ctx.session.city && ctx.session.city !== 'Усі' ? `${r[1]}`.trim() === ctx.session.city : true))
      .sort((a, b) => a.s - b.s)
      .map(({ r }) => r);

    if (!filtered.length) return ctx.reply(`Нічого не знайдено для міста “${ctx.session.city}”.`);

    const msg = '📆 <b>Найближчі курси:</b>\n\n' + filtered
      .slice(0, 8)
      .map((r) => courseToHtml(r))
      .join('\n\n');

    await ctx.replyWithHTML(msg);
  } catch (err) {
    console.error('❌ Помилка розкладу:', err);
    ctx.reply('⚠️ Помилка під час отримання даних.');
  }
});

// === Форматування курсу ===
function courseToHtml(row = []) {
  const [groupId, city, course, start, end, instructor, price] = row;
  return (
    `🏙 <b>${city || '-'}</b>\n🎓 ${course || '-'}\n👩‍🏫 ${instructor || '-'}\n💰 ${price || '-'}\n📅 ${start} — ${end}\n🆔 <code>${groupId || '-'}</code>`
  );
}
function parseDate(d) {
  if (!d) return null;
  const parts = d.split('.');
  const [dd, mm, yyyy] = [Number(parts[0]), Number(parts[1]), Number(parts[2] || new Date().getFullYear())];
  return new Date(yyyy, mm - 1, dd);
}

// === Обробка помилок ===
process.on('uncaughtException', (err) => console.error('💥 Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('⚠️ Unhandled Rejection:', err));

// === Запуск ===
bot.launch()
  .then(() => {
    console.log('🚀 Бот запущено у polling режимі');
    bot.telegram.sendMessage(process.env.DEFAULT_CHAT_ID, '✅ Бот запущено та готовий до роботи!');
  })
  .catch((e) => console.error('❌ Помилка запуску:', e));
