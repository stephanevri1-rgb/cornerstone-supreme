import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const API_KEY = process.env.API_KEY || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '0718374853';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL;

const WHATSAPP_API = 'https://waba-v2.360dialog.io';
let db;

async function initDatabase() {
  if (!DATABASE_URL) {
    console.log('No database - running in demo mode');
    return;
  }
  try {
    const match = DATABASE_URL.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
    if (match) {
      const [, user, password, host, port, database] = match;
      db = await mysql.createPool({
        host, user, password, database, port: parseInt(port),
        waitForConnections: true, connectionLimit: 5,
      });
      await db.execute(`CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_phone VARCHAR(50) NOT NULL,
        student_name VARCHAR(255) DEFAULT 'Student',
        language VARCHAR(20) DEFAULT 'en',
        status ENUM('active','resolved','enrolled') DEFAULT 'active',
        last_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        conversation_id INT,
        sender ENUM('student','ai') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      console.log('Database connected!');
    }
  } catch (err) {
    console.error('DB error:', err.message);
  }
}

async function generateResponse(message) {
  const lower = message.toLowerCase();
  let intent = 'general';
  if (/\b(hi|hello|hey|sawubona|hallo)\b/.test(lower)) intent = 'greeting';
  else if (/\b(price|cost|how much|fee|r\d|rand)\b/.test(lower)) intent = 'pricing';
  else if (/\b(enroll|register|sign up|apply)\b/.test(lower)) intent = 'enrollment';
  else if (/\b(brochure|catalog|pdf|send me)\b/.test(lower)) intent = 'brochure';
  else if (/\b(course|learn|study|training)\b/.test(lower)) intent = 'courses';
  
  let lang = 'en';
  if (/\b(dankie|hoeveel|kursus)\b/.test(lower)) lang = 'af';
  if (/\b(ngiyabonga|kanjani|isifundo)\b/.test(lower)) lang = 'zu';
  
  let response = '';
  if (intent === 'greeting') {
    response = `Hello! Welcome to Cornerstone Supreme Education. I'm your AI assistant. How can I help you today? We offer professional courses in Business, HR, Marketing, Finance, and more!`;
  }
  else if (intent === 'courses') {
    response = `We offer 8 professional courses at Cornerstone Supreme:\n\n1. Business Management - R8,500\n2. HR Management - R7,200\n3. Project Management - R9,500\n4. Digital Marketing - R6,500\n5. Leadership Development - R8,000\n6. Financial Management - R9,000\n7. Health & Safety - R5,500\n8. Customer Service - R4,500\n\nVisit: https://www.cornerstonehr.co.za\n\nWhich course interests you?`;
  }
  else if (intent === 'pricing') {
    response = `Our courses range from R4,500 to R9,500.\n\nPayment options:\n- Full payment (5% discount)\n- Monthly installments\n- Employer-sponsored\n\nWould you like pricing for a specific course?`;
  }
  else if (intent === 'enrollment') {
    response = `Great! To enroll:\n\n1. Visit: https://www.cornerstonehr.co.za\n2. Click "Enroll Now"\n3. Fill in your details\n4. Choose payment option\n\nOr tell me which course and I'll guide you!`;
  }
  else if (intent === 'brochure') {
    response = `Here's our course catalog:\nhttps://www.cornerstonehr.co.za\n\nWe have courses in:\n- Business Management\n- HR Management\n- Project Management\n- Digital Marketing\n- Leadership\n- Financial Management\n- Health & Safety\n- Customer Service\n\nWhich field interests you?`;
  }
  else {
    response = `Thank you for contacting Cornerstone Supreme Education! We offer industry-recognized professional courses.\n\nHow can I help?\n- Browse our courses\n- Check pricing\n- Enrollment info\n- Request a brochure`;
  }
  
  return { response, intent, lang };
}

async function sendWhatsAppMessage(to, message) {
  try {
    await fetch(`${WHATSAPP_API}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'D360-API-Key': API_KEY,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: message },
      }),
    });
    console.log('Message sent to', to);
  } catch (err) {
    console.error('Send failed:', err.message);
  }
}

async function saveConversation(phone, message, aiResponse, intent, lang) {
  if (!db) return;
  try {
    const [existing] = await db.execute('SELECT id FROM conversations WHERE student_phone = ?', [phone]);
    let convId;
    if (existing.length === 0) {
      const [result] = await db.execute(
        'INSERT INTO conversations (student_phone, language, last_message) VALUES (?,?,?)',
        [phone, lang, message]
      );
      convId = result.insertId;
    } else {
      convId = existing[0].id;
      await db.execute('UPDATE conversations SET last_message = ?, updated_at = NOW() WHERE id = ?', [message, convId]);
    }
    await db.execute('INSERT INTO messages (conversation_id, sender, content) VALUES (?,?,?)', [convId, 'student', message]);
    await db.execute('INSERT INTO messages (conversation_id, sender, content) VALUES (?,?,?)', [convId, 'ai', aiResponse]);
  } catch (err) {
    console.error('Save error:', err.message);
  }
}

app.get('/api/ping', (req, res) => res.json({ ok: true }));
app.get('/api/conversations', async (req, res) => {
  if (!db) return res.json([]);
  const [rows] = await db.execute('SELECT * FROM conversations ORDER BY updated_at DESC');
  res.json(rows);
});

app.get('/api/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/api/webhook/whatsapp', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return;
    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body || '';
    console.log(`Message from ${from}: ${text}`);
    const { response, intent, lang } = await generateResponse(text);
    await saveConversation(from, text, response, intent, lang);
    await sendWhatsAppMessage(from, response);
    console.log(`AI replied to ${from}`);
  } catch (err) {
    console.error('Error:', err.message);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Cornerstone Supreme AI running on port ${PORT}`);
    console.log(`Phone: ${BUSINESS_PHONE}`);
    console.log(`Webhook: /api/webhook/whatsapp`);
  });
});
