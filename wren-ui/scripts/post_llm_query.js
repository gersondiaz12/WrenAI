const http = require('http');
const data = JSON.stringify({ query: 'query { getLLMConfig }' });
const opts = {
  host: 'localhost',
  port: 3000,
  path: '/api/graphql',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
};
const req = http.request(opts, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    console.log('STATUS', res.statusCode);
    console.log('BODY', b);
  });
});
req.on('error', (e) => console.error('ERR', e));
req.write(data);
req.end();
