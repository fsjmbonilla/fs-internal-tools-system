import { pool } from '../db/index.js';
import { BOT_DISPLAY_NAME, ensureBotUser } from '../services/botService.js';

const id = await ensureBotUser();
console.log(`${BOT_DISPLAY_NAME} bot user ready (id ${id})`);
await pool.end();
