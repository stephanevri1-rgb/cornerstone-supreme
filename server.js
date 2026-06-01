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
