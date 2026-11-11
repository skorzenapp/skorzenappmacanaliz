'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8');
assert.ok(html.includes('index-BL0ucYsL.js'),'Original Maç Analiz bundle is present');
assert.ok(html.includes('index-LDPvv9LF.css'),'Original Maç Analiz stylesheet is present');
assert.ok(html.includes('/assets/defter.js'),'Defter integration is loaded');
assert.ok(html.includes('Powered by SportScore'),'Provider attribution is present');
assert.ok(fs.existsSync('server.js'));
assert.ok(fs.existsSync('assets/skorzen-v1.js'));
assert.ok(fs.existsSync('favorites.html'));
const server=fs.readFileSync('server.js','utf8');
assert.ok(server.includes('api\\/matches'),'Maç listesi adapter route is present');
assert.ok(server.includes("/api/search"),'Search adapter route is present');
assert.ok(server.includes("compatibility: { fixtures: true"),'API capability status is explicit');
for (const route of ['standingsMatch','matchCompat','teamCompat','matchPlayersCompat','playerCompat','predictCompat']) {
  assert.ok(server.includes(route), `Compatibility route ${route} exists`);
}
console.log('Static integration checks passed. Live upstream provider connectivity must be verified after deployment.');

const bundle=fs.readFileSync('assets/index-BL0ucYsL.js','utf8');
assert.ok(bundle.includes('const lN="";'),'Frontend API base points to same-origin server');
assert.ok(!bundle.includes('const lN="port/5000"'),'Preview-only port prefix removed');
