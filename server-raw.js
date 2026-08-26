// server-raw.js
const http = require('http');
const url = require('url');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DESTINO = {
  host: 'api-svsaude-hcommerce.hmg.marlin.com.br',
  port: 80
};

function parseMultipart(body, boundary) {
  const result = {
    fields: {},
    files: []
  };
  
  const parts = body.split('--' + boundary);
  
  parts.forEach(function(part) {
    let cleanPart = part.replace(/--\s*$/, '').trim();
    if (!cleanPart || cleanPart === '--') return;
    
    const separatorIndex = cleanPart.indexOf('\r\n\r\n');
    if (separatorIndex === -1) return;
    
    const headerSection = cleanPart.substring(0, separatorIndex);
    const content = cleanPart.substring(separatorIndex + 4);
    
    const contentDisposition = headerSection.match(/Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]+)")?/i);
    const contentType = headerSection.match(/Content-Type: (.+)/i);
    
    if (contentDisposition) {
      const name = contentDisposition[1];
      const filename = contentDisposition[2];
      
      if (filename) {
        const fileContent = content.replace(/\r\n$/, '');
        result.files.push({
          fieldName: name,
          filename: filename,
          contentType: contentType ? contentType[1].trim() : 'application/octet-stream',
          size: fileContent.length,
          data: fileContent
        });
      } else {
        result.fields[name] = content.replace(/\r\n$/, '');
      }
    }
  });
  
  return result;
}

function cleanHeaders(headers) {
  const cleaned = {};
  
  // Headers que não devem ser encaminhados
  const blockedHeaders = [
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'accept-language',
    'accept-charset',
    'cookie',
    'set-cookie'
  ];
  
  Object.keys(headers).forEach(function(key) {
    const lowerKey = key.toLowerCase();
    
    // Pula headers bloqueados
    if (blockedHeaders.includes(lowerKey)) {
      return;
    }
    
    // Pula headers com valores vazios ou undefined
    if (headers[key] === undefined || headers[key] === null) {
      return;
    }
    
    // Mantém o header original com o mesmo case
    cleaned[key] = headers[key];
  });
  
  return cleaned;
}

const server = http.createServer(function(req, res) {
  
  // ============ RESPONDER PREFLIGHT OPTIONS ============
  if (req.method === 'OPTIONS') {
    console.log('\n' + '='.repeat(80));
    console.log('PREFLIGHT OPTIONS RECEBIDO');
    console.log('='.repeat(80));
    console.log('Endpoint: ' + req.url);
    
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
  
  // ============ REQUISICAO REAL ============
  const chunks = [];
  let bodyBuffer;
  
  req.on('data', function(chunk) {
    chunks.push(chunk);
  });
  
  req.on('end', function() {
    bodyBuffer = Buffer.concat(chunks);
    const bodyString = bodyBuffer.toString();
    
    const parsedUrl = url.parse(req.url, true);
    const contentType = req.headers['content-type'] || '';
    const isMultipart = contentType.includes('multipart/form-data');
    
    console.log('\n' + '='.repeat(80));
    console.log('REQUISICAO RECEBIDA');
    console.log('='.repeat(80));
    console.log('Data/Hora: ' + new Date().toLocaleString('pt-BR'));
    console.log('Metodo: ' + req.method);
    console.log('URL: ' + req.url);
    console.log('Path: ' + parsedUrl.pathname);
    console.log('Query: ' + (parsedUrl.search || 'Nenhuma'));
    console.log('IP: ' + req.socket.remoteAddress);
    console.log('Content-Type: ' + contentType);
    console.log('Content-Length: ' + (req.headers['content-length'] || '0'));
    
    if (req.headers['authorization']) {
      console.log('Authorization: PRESENTE');
    }
    
    if (bodyBuffer.length > 0) {
      console.log('Body Size: ' + bodyBuffer.length + ' bytes');
    }
    
    // ============ PREPARAR ENCAMINHAMENTO ============
    console.log('\n' + '='.repeat(80));
    console.log('ENCAMINHANDO PARA DESTINO');
    console.log('='.repeat(80));
    
    // Limpa headers problemáticos
    const cleanReqHeaders = cleanHeaders(req.headers);
    
    // Adiciona headers úteis para o destino
    const forwardHeaders = {
      ...cleanReqHeaders,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-host': req.headers.host || 'localhost',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': req.headers.host ? req.headers.host.split(':')[1] || '80' : '80',
      'x-proxy-server': 'node-interceptor-raw',
      'x-original-url': req.url
    };
    
    // Se tem Content-Type, mantém
    if (contentType) {
      forwardHeaders['content-type'] = contentType;
    }
    
    // Se tem body, adiciona content-length
    if (bodyBuffer.length > 0) {
      forwardHeaders['content-length'] = bodyBuffer.length;
    }
    
    const forwardPath = req.url;
    const targetUrl = 'https://' + DESTINO.host + ':' + DESTINO.port + forwardPath;
    
    console.log('URL Destino: ' + targetUrl);
    console.log('Metodo: ' + req.method);
    console.log('Headers encaminhados:');
    
    Object.keys(forwardHeaders).forEach(function(key) {
      const value = forwardHeaders[key];
      if (key.toLowerCase() === 'authorization') {
        console.log('  ' + key + ': [PRESENTE]');
      } else if (typeof value === 'string' && value.length > 100) {
        console.log('  ' + key + ': ' + value.substring(0, 100) + '...');
      } else {
        console.log('  ' + key + ': ' + value);
      }
    });
    
    if (bodyBuffer.length > 0) {
      console.log('Body: ' + bodyBuffer.length + ' bytes');
      if (!isMultipart && !contentType.includes('application/json')) {
        console.log('Body Preview: ' + bodyString.substring(0, 200) + (bodyString.length > 200 ? '...' : ''));
      }
    }
    
    // ============ FAZER REQUISIÇÃO PARA O DESTINO ============
    const options = {
      hostname: DESTINO.host,
      port: DESTINO.port,
      path: forwardPath,
      method: req.method,
      headers: forwardHeaders,
      // Importante para evitar problemas de timeout
      timeout: 30000
    };
    
    const proxyReq = http.request(options, function(proxyRes) {
      console.log('\nRESPOSTA DO DESTINO:');
      console.log('-'.repeat(80));
      console.log('Status: ' + proxyRes.statusCode + ' ' + proxyRes.statusMessage);
      
      let responseChunks = [];
      proxyRes.on('data', function(chunk) {
        responseChunks.push(chunk);
      });
      
      proxyRes.on('end', function() {
        const responseBody = Buffer.concat(responseChunks).toString();
        
        console.log('Response Size: ' + responseBody.length + ' bytes');
        if (responseBody) {
          try {
            const jsonBody = JSON.parse(responseBody);
            console.log('Response Body (JSON):');
            console.log(JSON.stringify(jsonBody, null, 2));
          } catch {
            console.log('Response Body (Text):');
            console.log(responseBody.substring(0, 500) + (responseBody.length > 500 ? '...' : ''));
          }
        }
        console.log('='.repeat(80) + '\n');
        
        // CORS headers para resposta
        const corsHeaders = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true'
        };
        
        const headers = {
          ...proxyRes.headers,
          ...corsHeaders
        };
        
        // Remove headers problemáticos da resposta
        delete headers['connection'];
        delete headers['transfer-encoding'];
        
        res.writeHead(proxyRes.statusCode, headers);
        res.end(responseBody);
      });
    });
    
    proxyReq.on('error', function(error) {
      console.error('\nERRO NO ENCAMINHAMENTO:');
      console.log('-'.repeat(80));
      console.error('Erro: ' + error.message);
      console.error('Target: ' + targetUrl);
      
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Content-Type': 'application/json'
      };
      
      res.writeHead(500, corsHeaders);
      res.end(JSON.stringify({
        error: 'Erro no encaminhamento',
        message: error.message,
        target: targetUrl,
        timestamp: new Date().toISOString()
      }));
    });
    
    // Timeout da requisição
    proxyReq.on('timeout', function() {
      console.error('\nTIMEOUT NO ENCAMINHAMENTO');
      console.log('-'.repeat(80));
      console.error('Target: ' + targetUrl);
      proxyReq.destroy();
    });
    
    // Envia o body se existir
    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('\n' + '='.repeat(80));
  console.log('SERVIDOR MIDDLEWARE DE INSPECAO E ENCAMINHAMENTO');
  console.log('='.repeat(80));
  console.log('Rodando em: http://localhost:' + PORT);
  
  const networkInterfaces = os.networkInterfaces();
  console.log('\nACESSIVEL EM:');
  Object.keys(networkInterfaces).forEach(function(interfaceName) {
    networkInterfaces[interfaceName].forEach(function(iface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('  http://' + iface.address + ':' + PORT);
      }
    });
  });
  
  console.log('\nENCAMINHANDO PARA: ' + DESTINO.host + ':' + DESTINO.port);
  console.log('Exemplo: /api/propostas/123 -> https://' + DESTINO.host + ':' + DESTINO.port + '/api/propostas/123');
  console.log('\nPressione Ctrl+C para parar');
  console.log('='.repeat(80) + '\n');
});