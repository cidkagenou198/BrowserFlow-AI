'use strict';

const http = require('http');
const assert = require('assert');
const app = require('../server');
const { parseInstructionRegex } = require('../agent');

console.log('🚀 Starting BrowserFlow AI Smoke Tests...\n');

// 1. Test Natural Language Parser (Offline / Rule-based)
console.log('▶ [1/4] Testing natural language regex parser...');
const plan = parseInstructionRegex(
  'Open https://example.com and fill the username field with "testuser" and click on Submit',
  () => {}
);

assert(plan, 'Plan should be returned');
assert.strictEqual(plan.url, 'https://example.com');
assert(Array.isArray(plan.actions), 'Parsed actions should be an array');
assert(plan.actions.length >= 2, `Expected at least 2 actions, got ${plan.actions.length}`);
console.log('  ✔ Parser generated correct sequence of actions:', { url: plan.url, actionCount: plan.actions.length });

// Helper for making HTTP requests
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

// 2. Start Express app on dynamic ephemeral port
const server = app.listen(0, async () => {
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;
  console.log(`\n▶ [2/4] Started test server on port ${port}...`);

  try {
    // 3. Test Health Endpoint
    console.log('▶ [3/4] Testing /api/health and /api/config endpoints...');
    const healthRes = await get(`${baseUrl}/api/health`);
    assert.strictEqual(healthRes.statusCode, 200, 'Health endpoint should return HTTP 200');
    const healthJson = JSON.parse(healthRes.body);
    assert.strictEqual(healthJson.status, 'ok', 'Health status should be "ok"');
    console.log('  ✔ Health check passed:', healthJson.status);

    const configRes = await get(`${baseUrl}/api/config`);
    assert.strictEqual(configRes.statusCode, 200, 'Config endpoint should return HTTP 200');
    const configJson = JSON.parse(configRes.body);
    assert(typeof configJson === 'object', 'Config should return an object');
    console.log('  ✔ Config check passed (detected providers):', Object.keys(configJson).filter(k => configJson[k]));

    // 4. Test UI Index Page Serving
    console.log('\n▶ [4/4] Testing Web UI static serving...');
    const indexRes = await get(`${baseUrl}/`);
    assert.strictEqual(indexRes.statusCode, 200, 'Root / should return HTTP 200');
    assert(indexRes.body.includes('Aetheris') || indexRes.body.includes('BrowserFlow') || indexRes.body.includes('Website Automation Agent'), 'Index should contain app title');
    console.log('  ✔ Web UI index.html served successfully.');

    console.log('\n🎉 ALL SMOKE TESTS PASSED SUCCESSFULLY! Ready for production.\n');
    server.close(() => process.exit(0));
  } catch (err) {
    console.error('\n❌ Smoke test failed:', err);
    server.close(() => process.exit(1));
  }
});
