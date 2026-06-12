const http = require('http');
const fs = require('fs');
const path = require('path');
const root = 'C:/baseball-site';
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.txt':'text/plain; charset=utf-8'};
const server = http.createServer((req,res)=>{
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/baseball-mobile.html';
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(path.normalize(root))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err,data)=>{
    if (err) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); res.end('not found: '+urlPath); return; }
    res.writeHead(200, {'content-type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'cache-control':'no-store'});
    res.end(data);
  });
});
server.listen(8766, '127.0.0.1', () => console.log('http://127.0.0.1:8766/baseball-mobile.html'));
