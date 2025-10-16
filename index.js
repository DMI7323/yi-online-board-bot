import { getSheetData } from './utils/sheets.js';

(async () => {
  try {
    const data = await getSheetData('ГРУППЫ!A1:F5');
    console.log('✅ Успішне підключення до Google Sheets!');
    console.log(data);
  } catch (error) {
    console.error('❌ Помилка:', error.message);
  }
})();
