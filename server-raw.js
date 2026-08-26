// server-raw.js
const http = require('http');
const url = require('url');
const os = require('os');

const PORT = process.env.PORT || 3000;

const DESTINO = {
  host: 'api-svsaude-hcommerce.hmg.marlin.com.br',
  port: 80
};

console.log('🚀 Iniciando servidor...');
console.log('📡 Destino:', DESTINO.host + ':' + DESTINO.port);

// Health check
function handleHealthCheck(req, res) {
  res.writeHead(200, { 
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    destino: DESTINO,
    nodeVersion: process.version
  }));
}

const server = http.createServer(function(req, res) {
  // Health check
  if (req.url === '/health' || req.url === '/ping') {
    return handleHealthCheck(req, res);
  }

  // PREFLIGHT OPTIONS
  if (req.method === 'OPTIONS') {
    console.log('📨 OPTIONS request para:', req.url);
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Credentials': 'true'
    });
    res.end();
    return;
  }

  // REQUISIÇÃO REAL
  console.log('📨 Requisição:', req.method, req.url);
  
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  
  req.on('end', function() {
    const bodyBuffer = Buffer.concat(chunks);
    
    // Verifica timeout
    const requestTimeout = setTimeout(() => {
      console.error('⏰ Timeout na requisição para:', req.url);
      res.writeHead(504, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        error: 'Gateway Timeout',
        message: 'O servidor destino demorou muito para responder',
        timestamp: new Date().toISOString()
      }));
    }, 25000); // 25 segundos

    const parsedUrl = url.parse(req.url, true);
    const contentType = req.headers['content-type'] || '';

    // Prepara headers
    const forwardHeaders = {
      ...req.headers,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-host': req.headers.host || 'localhost',
      'x-forwarded-proto': 'https',
      'x-proxy-server': 'node-interceptor-raw'
    };

    // Remove headers problemáticos
    delete forwardHeaders['host'];
    delete forwardHeaders['connection'];
    delete forwardHeaders['content-length'];
    delete forwardHeaders['transfer-encoding'];

    if (bodyBuffer.length > 0) {
      forwardHeaders['content-length'] = bodyBuffer.length;
    }

    console.log('➡️ Encaminhando para:', DESTINO.host + ':' + DESTINO.port + req.url);

    const options = {
      hostname: DESTINO.host,
      port: DESTINO.port,
      path: req.url,
      method: req.method,
      headers: forwardHeaders,
      timeout: 15000 // 15 segundos
    };

    const proxyReq = http.request(options, function(proxyRes) {
      clearTimeout(requestTimeout);
      console.log('⬅️ Resposta do destino:', proxyRes.statusCode);

      let responseChunks = [];
      proxyRes.on('data', chunk => responseChunks.push(chunk));
      
      proxyRes.on('end', function() {
        const responseBody = Buffer.concat(responseChunks);
        
        // CORS headers
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true'
        };

        const headers = { ...proxyRes.headers, ...corsHeaders };
        delete headers['connection'];
        delete headers['transfer-encoding'];

        res.writeHead(proxyRes.statusCode, headers);
        res.end(responseBody);
      });
    });

    proxyReq.on('error', function(error) {
      clearTimeout(requestTimeout);
      console.error('❌ Erro no proxy:', error.message);
      
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        error: 'Bad Gateway',
        message: error.message,
        destino: DESTINO.host + ':' + DESTINO.port,
        timestamp: new Date().toISOString()
      }));
    });

    proxyReq.on('timeout', function() {
      clearTimeout(requestTimeout);
      console.error('⏰ Timeout no proxy');
      proxyReq.destroy();
      res.writeHead(504, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        error: 'Gateway Timeout',
        message: 'Timeout ao conectar no servidor destino',
        timestamp: new Date().toISOString()
      }));
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('✅ Servidor rodando na porta:', PORT);
  console.log('📡 Destino configurado:', DESTINO.host + ':' + DESTINO.port);
  console.log('🔍 Health check: http://localhost:' + PORT + '/health');
});
