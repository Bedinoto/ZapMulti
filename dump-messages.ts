import Database from 'better-sqlite3';
const db = new Database('whatsapp_v2.db');
const messagesCount = db.prepare("SELECT count(*) as count FROM messages").get();
const contactsCount = db.prepare("SELECT count(*) as count FROM contacts").get();
console.log(`Contacts: ${contactsCount.count}, Messages: ${messagesCount.count}`);
const messages = db.prepare("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10").all();
console.log(JSON.stringify(messages, null, 2));
const contacts = db.prepare("SELECT * FROM contacts ORDER BY last_message_at DESC LIMIT 10").all();
console.log(JSON.stringify(contacts, null, 2));
