import { getSheetData } from './utils/sheets.js';

(async () => {
  try {
    const data = await getSheetData('ГРУППЫ!A1:F5'); // назва твого аркуша + діапазон
    console.log('✅ Підключення успішне!');
    console.log(data);
  } catch (err) {
    console.error('❌ Помилка підключення:', err.message);
  }
})();
