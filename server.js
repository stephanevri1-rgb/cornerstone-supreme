import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.API_KEY || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '0718374853';
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';

const WHATSAPP_API = 'https://waba-v2.360dialog.io';
let db = null;

async function initDatabase() {
  if (!DATABASE_URL) {
    console.log('WARNING: No DATABASE_URL - running without database');
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
      await db.execute(`CREATE TABLE IF NOT EXISTS courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        description TEXT,
        price VARCHAR(50),
        duration VARCHAR(100),
        format VARCHAR(50) DEFAULT 'Online',
        certification VARCHAR(255) DEFAULT 'Certificate of Completion',
        brochure_url TEXT,
        status ENUM('published','draft') DEFAULT 'published',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        email VARCHAR(320),
        language VARCHAR(20) DEFAULT 'en',
        status ENUM('new','interested','enrolled','dormant','objection','follow_up') DEFAULT 'new',
        source VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT,
        student_name VARCHAR(255) DEFAULT 'Student',
        student_phone VARCHAR(50) NOT NULL,
        language VARCHAR(20) DEFAULT 'en',
        status ENUM('active','resolved','enrolled','follow_up') DEFAULT 'active',
        intent VARCHAR(100),
        agent_used VARCHAR(100),
        ai_handling BOOLEAN DEFAULT true,
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
      await db.execute(`CREATE TABLE IF NOT EXISTS enrollments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id INT,
        student_name VARCHAR(255),
        student_phone VARCHAR(50),
        course_id INT,
        course_name VARCHAR(255),
        amount VARCHAR(50),
        status ENUM('pending','confirmed','cancelled') DEFAULT 'pending',
        payment_status ENUM('pending','paid','partial','overdue') DEFAULT 'pending',
        enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS brochures (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        filename VARCHAR(255),
        mime_type VARCHAR(100),
        size VARCHAR(50),
        data LONGTEXT,
        category VARCHAR(100) DEFAULT 'General',
        is_default BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS settings (
        key_name VARCHAR(255) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS agent_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id VARCHAR(100),
        conversation_id INT,
        action VARCHAR(255),
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`);
      const [existing] = await db.execute('SELECT COUNT(*) as count FROM courses');
      if (existing[0].count === 0) {
        const courses = [
          ['Business Management', 'Business', 'R8,500', '12 weeks', 'Comprehensive business management certification'],
          ['HR Management', 'HR', 'R7,200', '10 weeks', 'Professional HR management course'],
          ['Project Management', 'Business', 'R9,500', '8 weeks', 'PMP-aligned project management'],
          ['Digital Marketing', 'Marketing', 'R6,500', '6 weeks', 'Complete digital marketing training'],
          ['Leadership Development', 'Business', 'R8,000', '8 weeks', 'Executive leadership program'],
          ['Financial Management', 'Finance', 'R9,000', '10 weeks', 'Corporate finance and accounting'],
          ['Occupational Health & Safety', 'Health & Safety', 'R5,500', '4 weeks', 'OHSA-compliant safety training'],
          ['Customer Service Excellence', 'Business', 'R4,500', '4 weeks', 'World-class customer service training'],
        ];
        for (const c of courses) {
          await db.execute('INSERT INTO courses (title, category, price, duration, description) VALUES (?,?,?,?,?)', c);
        }
        console.log('8 default courses seeded');
      }
      await db.execute(`INSERT IGNORE INTO settings (key_name, value) VALUES 
        ('companyName', 'Cornerstone Supreme'),
        ('companyPhone', '0718374853'),
        ('companyWebsite', 'https://www.cornerstonehr.co.za'),
        ('brochureUrl', 'https://www.cornerstonehr.co.za')
      `);
      console.log('Database connected and tables created!');
    }
  } catch (err) {
    console.error('Database connection failed:', err.message);
  }
}

function trpcResponse(data, error = null) {
  if (error) {
    return { result: { data: { json: null } }, error: { message: error } };
  }
  return { result: { data: { json: data } } };
}

function parseTrpcInput(req) {
  return req.body?.json || req.body || {};
}

// AI RESPONSE ENGINE
const COURSES = [
  { title: 'Business Management', category: 'Business', price: 'R8,500', duration: '12 weeks' },
  { title: 'HR Management', category: 'HR', price: 'R7,200', duration: '10 weeks' },
  { title: 'Project Management', category: 'Business', price: 'R9,500', duration: '8 weeks' },
  { title: 'Digital Marketing', category: 'Marketing', price: 'R6,500', duration: '6 weeks' },
  { title: 'Leadership Development', category: 'Business', price: 'R8,000', duration: '8 weeks' },
  { title: 'Financial Management', category: 'Finance', price: 'R9,000', duration: '10 weeks' },
  { title: 'Health & Safety', category: 'Health & Safety', price: 'R5,500', duration: '4 weeks' },
  { title: 'Customer Service', category: 'Business', price: 'R4,500', duration: '4 weeks' },
];

function detectIntent(msg) {
  const lower = msg.toLowerCase();
  if (/\b(hi|hello|hey|sawubona|hallo|molo)\b/.test(lower)) return 'greeting';
  if (/\b(price|cost|how much|fee|r\d|rand|expensive|cheap)\b/.test(lower)) return 'pricing';
  if (/\b(enroll|register|sign up|apply|join|how do i|payment|pay|bank|account|transfer|eft)\b/.test(lower)) return 'enrollment';
  if (/\b(brochure|catalog|pdf|send me|download|more info|list)\b/.test(lower)) return 'brochure';
  if (/\b(course|learn|study|training|qualification|program|diploma|certificate)\b/.test(lower)) return 'courses';
  if (/\b(thank|thanks|dankie|ngiyabonga)\b/.test(lower)) return 'thanks';
  if (/\b(bye|goodbye|cheers)\b/.test(lower)) return 'goodbye';
  return 'general';
}

function detectLanguage(msg) {
  const lower = msg.toLowerCase();
  if (/\b(dankie|hoeveel|kursus|leer|goed|ja|nee|baie)\b/.test(lower)) return 'af';
  if (/\b(ngiyabonga|kanjani|isifundo|funda|yebo|cha|unjani)\b/.test(lower)) return 'zu';
  return 'en';
}

async function generateAIResponse(message) {
  const intent = detectIntent(message);
  const lang = detectLanguage(message);
  
  const responses = {
    greeting: {
      en: `Hello! Welcome to Cornerstone Supreme Education. I'm your AI assistant, available 24/7 to help you.\n\nWe offer 8 professional courses with industry-recognized certifications.\n\nHow can I help you today?`,
      af: `Hallo! Welkom by Cornerstone Supreme Education. Ek is jou AI-assistent, beskikbaar 24/7 om jou te help.\n\nOns bied 8 professionele kursusse aan. Hoe kan ek jou help?`,
      zu: `Sawubona! Siyakwamukela eCornerstone Supreme Education. Ngingumsizi wakho we-AI.\n\nSinikeza izifundo eziyisishiyagalombili. Ngingakusiza kanjani?`,
    },
    courses: {
      en: `We offer 8 professional courses at Cornerstone Supreme:\n\n${COURSES.map((c, i) => `${i+1}. ${c.title} (${c.category}) - ${c.price}`).join('\n')}\n\nVisit our website: https://www.cornerstonehr.co.za\n\nWhich course interests you? I can provide more details!`,
    },
    pricing: {
      en: `Our courses range from R4,500 to R9,500 depending on the program.\n\nPopular courses:\n${COURSES.slice(0, 4).map(c => `- ${c.title}: ${c.price}`).join('\n')}\n\nPayment options:\n- Full payment (5% discount)\n- Monthly installments\n- Employer-sponsored\n\nWould you like pricing for a specific course?`,
    },
    enrollment: {
      en: `Excellent choice! Here's how to enroll at Cornerstone Supreme:\n\n1. Visit: https://www.cornerstonehr.co.za\n2. Click "Enroll Now" on your chosen course\n3. Fill in your details\n4. Choose payment option (full or installments)\n5. You'll receive confirmation within 24 hours\n\nOr tell me which course and I'll guide you step by step!`,
    },
    brochure: {
      en: `Here's our course catalog:\nhttps://www.cornerstonehr.co.za\n\nWe offer courses in:\n- Business Management\n- HR Management\n- Project Management\n- Digital Marketing\n- Leadership Development\n- Financial Management\n- Health & Safety\n- Customer Service\n\nWhich field interests you? I can send specific details.`,
    },
    thanks: {
      en: `You're welcome! If you have any more questions about our courses, feel free to ask. I'm here 24/7!`,
    },
    goodbye: {
      en: `Goodbye! Thank you for your interest in Cornerstone Supreme. Feel free to message us anytime. Have a great day!`,
    },
    general: {
      en: `Thank you for contacting Cornerstone Supreme Education! We offer industry-recognized professional courses.\n\nHow can I help you today?\n- Browse our 8 courses\n- Check pricing\n- Enrollment information\n- Request a brochure\n- Payment options`,
    },
  };
  
  return {
    response: (responses[intent]?.[lang] || responses[intent]?.en || responses.general.en),
    intent,
    lang,
  };
}

async function sendWhatsAppMessage(to, message) {
  if (!API_KEY) { console.log('No API key - message not sent'); return; }
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
        to,
        type: 'text',
        text: { body: message },
      }),
    });
    console.log('Message sent to', to);
  } catch (err) {
    console.error('Send failed:', err.message);
  }
}

async function saveMessage(phone, name, message, aiResponse, intent, lang) {
  if (!db) return;
  try {
    const [existing] = await db.execute('SELECT id FROM conversations WHERE student_phone = ?', [phone]);
    let convId;
    if (existing.length === 0) {
      const [result] = await db.execute(
        'INSERT INTO conversations (student_phone, student_name, language, last_message, intent) VALUES (?,?,?,?,?)',
        [phone, name, lang, message, intent]
      );
      convId = result.insertId;
    } else {
      convId = existing[0].id;
      await db.execute('UPDATE conversations SET last_message = ?, intent = ?, updated_at = NOW() WHERE id = ?', [message, intent, convId]);
    }
    await db.execute('INSERT INTO messages (conversation_id, sender, content) VALUES (?,?,?)', [convId, 'student', message]);
    await db.execute('INSERT INTO messages (conversation_id, sender, content) VALUES (?,?,?)', [convId, 'ai', aiResponse]);
    await db.execute('INSERT INTO agent_logs (agent_id, conversation_id, action, details) VALUES (?,?,?,?)',
      ['sales_responder', convId, `Response: ${intent}`, `Language: ${lang}`]);
  } catch (err) {
    console.error('Save error:', err.message); 
  }
}
