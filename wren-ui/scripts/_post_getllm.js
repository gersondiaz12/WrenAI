const http = require('http');
const p = process.argv[2] || 3002;
const data = JSON.stringify({ query: 'query { getLLMConfig }' });
const opts = { host: '127.0.0.1', port: p, path: '/api/graphql', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000 };
const req = http.request(opts, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { console.log('RESP', b); }); });
req.on('error', e => console.error('ERR', e && e.message));
req.write(data); req.end();
