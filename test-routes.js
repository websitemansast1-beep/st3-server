// test-routes.js - Run this on Railway or locally to verify all routes
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:3000';

const tests = [
  { method: 'POST', path: '/api/auth/login', body: { username: 'admin', password: 'admin123' }, desc: 'Admin login' },
  { method: 'POST', path: '/api/auth/student-login', body: { code: 'TEST', name: 'Test' }, desc: 'Student login' },
  { method: 'GET', path: '/health', desc: 'Health check' },
];

async function test() {
  console.log('Testing backend routes...\n');
  for (const t of tests) {
    const options = {
      hostname: new URL(BASE).hostname,
      port: new URL(BASE).port || 80,
      path: t.path,
      method: t.method,
      headers: { 'Content-Type': 'application/json' }
    };

    const body = t.body ? JSON.stringify(t.body) : '';

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = res.statusCode;
        const ok = status === 200 ? '✅' : status === 404 ? '❌ 404' : `⚠️ ${status}`;
        console.log(`${ok} ${t.method} ${t.path} - ${t.desc}`);
        if (status !== 200) {
          console.log(`   Response: ${data.substring(0, 200)}`);
        }
      });
    });

    req.on('error', (e) => {
      console.log(`❌ ERROR: ${t.method} ${t.path} - ${e.message}`);
    });

    if (body) req.write(body);
    req.end();
  }
}

test();
