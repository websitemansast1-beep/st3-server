// test-gas-connection.js
// Diagnoses "timeout of 30000ms exceeded" errors by testing the GAS
// connection directly, step by step, and printing WHY it's failing
// instead of just the generic timeout message.
//
// Run this from the backend folder, wherever GAS_ENDPOINT_URL / GAS_API_KEY
// are set (locally with .env, or in Railway's Shell tab where the real
// production env vars are already loaded):
//
//   node scripts/test-gas-connection.js
//
require('dotenv').config();
const https = require('https');
const http = require('http');

const endpoint = process.env.GAS_ENDPOINT_URL;
const apiKey = process.env.GAS_API_KEY;

console.log('🔍 فحص الاتصال بـ Google Apps Script...\n');

if (!endpoint) {
  console.log('❌ GAS_ENDPOINT_URL مش موجود في الـ .env أصلاً.');
  console.log('   لازم تحط رابط الـ Apps Script Web App اللي طلع لك بعد الـ Deploy.');
  process.exit(1);
}
console.log('📍 الرابط اللي هيتفحص:', endpoint);

if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/.test(endpoint)) {
  console.log('⚠️  الرابط ده شكله مش زي رابط Apps Script Web App عادي');
  console.log('   (المفروض يبدأ بـ https://script.google.com/macros/s/ وينتهي بـ /exec).');
  console.log('   لو نسخته من مكان تاني (مثلاً رابط تعديل الكود بدل رابط الـ deployment)، ده سبب المشكلة غالبًا.\n');
}

if (!apiKey) {
  console.log('⚠️  GAS_API_KEY مش موجود في الـ .env — لو الـ Apps Script بيتحقق منه، كل طلب هيترفض أو يتجاهل.\n');
}

const url = new URL(endpoint);
const lib = url.protocol === 'https:' ? https : http;
const payload = JSON.stringify({ apiKey: apiKey || '', action: 'getSettings', payload: {} });

const start = Date.now();
console.log('\n⏳ بابعت طلب فعلي وباستنى الرد (لحد 35 ثانية)...\n');

const req = lib.request(
  {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 35000
  },
  (res) => {
    const elapsed = Date.now() - start;
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      console.log(`⏱  الرد جه بعد ${elapsed}ms — HTTP status: ${res.statusCode}`);

      if (res.statusCode === 302 || res.statusCode === 301) {
        console.log('❌ السيرفر بيعمل Redirect (بيرجع صفحة تسجيل دخول جوجل غالبًا).');
        console.log('   ده معناه إعدادات المشاركة غلط — روح Apps Script → Deploy → Manage deployments');
        console.log('   وتأكد "Execute as: Me" و "Who has access: Anyone".');
        return;
      }
      if (res.statusCode !== 200) {
        console.log('❌ السيرفر رد بحالة مش طبيعية. أول 300 حرف من الرد:');
        console.log(data.slice(0, 300));
        return;
      }

      try {
        const parsed = JSON.parse(data);
        if (parsed.ok === false) {
          console.log('⚠️  الـ Apps Script نفسه رد بخطأ:', parsed.error);
          console.log('   يعني الاتصال شغال، بس فيه مشكلة جوه كود الـ Apps Script نفسه (Code.gs) أو اسم شيت غلط.');
        } else {
          console.log('✅ الاتصال شغال تمام! الرد جه بشكل صحيح خلال', elapsed, 'ms.');
          console.log('   لو لسه بتاخد timeout في الموقع، غالبًا المشكلة حصلت وقت زحمة/حمل عالي مؤقت، مش إعدادات غلط.');
        }
      } catch (e) {
        console.log('❌ الرد اللي جه مش JSON صحيح. أول 300 حرف:');
        console.log(data.slice(0, 300));
        console.log('   لو الرد ده صفحة HTML فيها كلمة "Google" أو "Sign in"، فده تأكيد إن المشكلة في إعدادات المشاركة (نفس نقطة "Execute as / Who has access" فوق).');
      }
    });
  }
);

req.on('timeout', () => {
  console.log(`❌ عدى 35 ثانية ومفيش رد خالص.`);
  console.log('   الاحتمال الأكبر: رابط الـ Apps Script قديم/معطل، أو السيرفر نفسه مش عارف يوصل لـ script.google.com (فيروول/شبكة).');
  req.destroy();
});
req.on('error', (e) => {
  console.log('❌ فشل الاتصال خالص:', e.message);
  console.log('   ده مش حتى timeout — الطلب فشل فورًا، غالبًا مشكلة شبكة/DNS أو الرابط مكتوب غلط.');
});

req.write(payload);
req.end();
