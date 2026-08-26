// server-raw.js
const http = require('http');
const url = require('url');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const PORT = 3000;
const DESTINO = {
  host: 'localhost',
  port: 60913
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
    'accept-encoding'
  ];
  
  Object.keys(headers).forEach(function(key) {
    const lowerKey = key.toLowerCase();
    
    if (blockedHeaders.includes(lowerKey)) {
      return;
    }
    
    if (headers[key] === undefined || headers[key] === null) {
      return;
    }
    
    cleaned[key] = headers[key];
  });
  
  return cleaned;
}

const server = http.createServer(function(req, res) {
  
  // ============ RESPONDER PREFLIGHT OPTIONS ============
  if (req.method === 'OPTIONS') {
    console.log('\n' + '='.repeat(80));
    console.log('PREFLIGHT OPTIONS');
    console.log('='.repeat(80));
    console.log('URL: ' + req.url);
    
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
    console.log('📥 REQUISIÇÃO RECEBIDA');
    console.log('='.repeat(80));
    console.log('🕐 Data/Hora: ' + new Date().toLocaleString('pt-BR'));
    console.log('🔗 URL Completa: ' + req.url);
    console.log('📍 Path: ' + parsedUrl.pathname);
    console.log('❓ Query String: ' + (parsedUrl.search || '(vazia)'));
    console.log('📌 Método: ' + req.method);
    console.log('🌐 IP Cliente: ' + req.socket.remoteAddress);
    console.log('🖥️  User-Agent: ' + (req.headers['user-agent'] || '(não enviado)'));
    console.log('📦 Content-Type: ' + (contentType || '(não enviado)'));
    console.log('📏 Content-Length: ' + (req.headers['content-length'] || '0'));
    
    // ============ TODOS OS HEADERS ============
    console.log('\n' + '🔷 TODOS OS HEADERS RECEBIDOS:');
    console.log('─'.repeat(80));
    const sortedHeaders = Object.keys(req.headers).sort();
    sortedHeaders.forEach(function(key) {
      const value = req.headers[key];
      if (key.toLowerCase() === 'authorization') {
        const parts = value.split(' ');
        if (parts.length === 2) {
          console.log('  ' + key + ': ' + parts[0] + ' ' + parts[1].substring(0, 20) + '... (tamanho: ' + parts[1].length + ' chars)');
        } else {
          console.log('  ' + key + ': ' + value.substring(0, 50) + '... (tamanho: ' + value.length + ' chars)');
        }
      } else {
        console.log('  ' + key + ': ' + value);
      }
    });
    
    // ============ QUERY PARAMETERS ============
    console.log('\n' + '🔶 QUERY PARAMETERS:');
    console.log('─'.repeat(80));
    if (Object.keys(parsedUrl.query).length > 0) {
      console.log(JSON.stringify(parsedUrl.query, null, 2));
    } else {
      console.log('(Nenhum query parameter)');
    }
    
    // ============ PARÂMETROS DA URL ============
    console.log('\n' + '🔶 PARÂMETROS DA URL (path segments):');
    console.log('─'.repeat(80));
    const pathParts = parsedUrl.pathname.split('/').filter(p => p);
    if (pathParts.length > 0) {
      pathParts.forEach(function(part, index) {
        console.log('  [' + index + '] ' + part + (isNaN(part) ? '' : ' (número)'));
      });
    } else {
      console.log('(Nenhum parâmetro na URL)');
    }
    
    // ============ BODY COMPLETO ============
    console.log('\n' + '🔷 BODY RECEBIDO:');
    console.log('─'.repeat(80));
    console.log('Tamanho: ' + bodyBuffer.length + ' bytes (' + (bodyBuffer.length / 1024).toFixed(2) + ' KB)');
    
    if (bodyBuffer.length === 0) {
      console.log('(Body vazio)');
    } else if (isMultipart) {
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        console.log('Tipo: MULTIPART/FORM-DATA');
        console.log('Boundary: ' + boundary);
        
        // Mostra o body cru
        console.log('\n📄 BODY CRU (primeiros 1000 caracteres):');
        console.log('─'.repeat(80));
        console.log(bodyString.substring(0, 1000) + (bodyString.length > 1000 ? '...\n(continua...)' : ''));
        
        const parsed = parseMultipart(bodyString, boundary);
        
        console.log('\n📝 CAMPOS DE TEXTO:');
        console.log('─'.repeat(80));
        if (Object.keys(parsed.fields).length > 0) {
          Object.keys(parsed.fields).forEach(function(key) {
            console.log('  ' + key + ': ' + parsed.fields[key]);
          });
        } else {
          console.log('  (Nenhum campo de texto)');
        }
        
        console.log('\n📎 ARQUIVOS (' + parsed.files.length + '):');
        console.log('─'.repeat(80));
        if (parsed.files.length > 0) {
          parsed.files.forEach(function(file, index) {
            console.log('\n  Arquivo #' + (index + 1) + ':');
            console.log('    Nome do campo: ' + file.fieldName);
            console.log('    Nome do arquivo: ' + file.filename);
            console.log('    Content-Type: ' + file.contentType);
            console.log('    Tamanho: ' + (file.size / 1024).toFixed(2) + ' KB (' + file.size + ' bytes)');
            
            // Detecta tipo do arquivo
            const hexPreview = Buffer.from(file.data.substring(0, 30)).toString('hex');
            let fileType = 'Desconhecido';
            const hex = hexPreview.toLowerCase();
            if (hex.startsWith('89504e47')) fileType = 'PNG Image';
            else if (hex.startsWith('ffd8ff')) fileType = 'JPEG Image';
            else if (hex.startsWith('47494638')) fileType = 'GIF Image';
            else if (hex.startsWith('25504446')) fileType = 'PDF Document';
            else if (hex.startsWith('504b0304')) fileType = 'ZIP/Office Document';
            else if (hex.startsWith('7b')) fileType = 'JSON File';
            else if (hex.startsWith('3c')) fileType = 'HTML/XML File';
            
            console.log('    Tipo detectado: ' + fileType);
            console.log('    Hex preview: ' + hexPreview);
            console.log('    Dados (primeiros 200 bytes):');
            console.log('    ' + file.data.substring(0, 200).replace(/\n/g, '\\n').replace(/\r/g, '\\r') + (file.data.length > 200 ? '...' : ''));
            
            // Salva o arquivo
            const uploadDir = './uploads';
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            const timestamp = Date.now();
            const random = crypto.randomBytes(4).toString('hex');
            const fileName = timestamp + '_' + random + '_' + file.filename;
            const filePath = uploadDir + '/' + fileName;
            
            try {
              fs.writeFileSync(filePath, file.data);
              console.log('    💾 Salvo em: ' + filePath);
            } catch (err) {
              console.log('    ❌ Erro ao salvar: ' + err.message);
            }
          });
        } else {
          console.log('  (Nenhum arquivo)');
        }
        
        console.log('\n📊 RESUMO DO FORM-DATA:');
        console.log('─'.repeat(80));
        console.log('  Campos de texto: ' + Object.keys(parsed.fields).length);
        console.log('  Arquivos: ' + parsed.files.length);
        const totalFilesSize = parsed.files.reduce(function(sum, f) { return sum + f.size; }, 0);
        console.log('  Tamanho total arquivos: ' + (totalFilesSize / 1024).toFixed(2) + ' KB');
        
      } else {
        console.log('❌ Boundary não encontrado no Content-Type');
        console.log(bodyString);
      }
    } else if (contentType.includes('application/json')) {
      console.log('Tipo: JSON');
      try {
        const jsonBody = JSON.parse(bodyString);
        console.log('\n📄 CONTEÚDO JSON:');
        console.log('─'.repeat(80));
        console.log(JSON.stringify(jsonBody, null, 2));
      } catch (e) {
        console.log('❌ Erro ao parsear JSON:');
        console.log(bodyString);
      }
    } else {
      console.log('Tipo: ' + (contentType || 'text/plain'));
      console.log('\n📄 CONTEÚDO DO BODY:');
      console.log('─'.repeat(80));
      console.log(bodyString);
    }
    
    // ============ ENCAMINHAMENTO ============
    console.log('\n' + '='.repeat(80));
    console.log('🚀 ENCAMINHANDO PARA DESTINO');
    console.log('='.repeat(80));
    
    // Prepara headers para encaminhamento
    const cleanReqHeaders = cleanHeaders(req.headers);
    const forwardHeaders = {
      ...cleanReqHeaders,
      'x-forwarded-for': req.socket.remoteAddress,
      'x-forwarded-host': req.headers.host || 'localhost',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': req.headers.host ? req.headers.host.split(':')[1] || '80' : '80',
      'x-proxy-server': 'node-interceptor-raw',
      'x-original-url': req.url,
      'x-proxy-timestamp': Date.now().toString()
    };
    
    // Mantém Content-Type e Content-Length corretos
    if (contentType) {
      forwardHeaders['content-type'] = contentType;
    }
    
    if (bodyBuffer.length > 0) {
      forwardHeaders['content-length'] = bodyBuffer.length;
    }
    
    const forwardPath = req.url;
    const targetUrl = 'http://' + DESTINO.host + ':' + DESTINO.port + forwardPath;
    
    console.log('\n📤 DETALHES DO ENCAMINHAMENTO:');
    console.log('─'.repeat(80));
    console.log('  URL Destino: ' + targetUrl);
    console.log('  Método: ' + req.method);
    console.log('  Body Size: ' + bodyBuffer.length + ' bytes');
    
    console.log('\n📋 HEADERS ENCAMINHADOS:');
    console.log('─'.repeat(80));
    Object.keys(forwardHeaders).sort().forEach(function(key) {
      const value = forwardHeaders[key];
      if (key.toLowerCase() === 'authorization') {
        const parts = value.split(' ');
        if (parts.length === 2) {
          console.log('  ' + key + ': ' + parts[0] + ' ' + parts[1].substring(0, 20) + '... (tamanho: ' + parts[1].length + ' chars)');
        } else {
          console.log('  ' + key + ': [PRESENTE]');
        }
      } else {
        console.log('  ' + key + ': ' + value);
      }
    });
    
    if (bodyBuffer.length > 0 && !isMultipart) {
      console.log('\n📄 BODY ENCAMINHADO:');
      console.log('─'.repeat(80));
      if (contentType.includes('application/json')) {
        try {
          const jsonBody = JSON.parse(bodyString);
          console.log(JSON.stringify(jsonBody, null, 2));
        } catch {
          console.log(bodyString);
        }
      } else {
        console.log(bodyString);
      }
    }
    
    // ============ FAZER REQUISIÇÃO ============
    const options = {
      hostname: DESTINO.host,
      port: DESTINO.port,
      path: forwardPath,
      method: req.method,
      headers: forwardHeaders,
      timeout: 30000
    };
    
    const proxyReq = http.request(options, function(proxyRes) {
      console.log('\n' + '='.repeat(80));
      console.log('📨 RESPOSTA DO DESTINO');
      console.log('='.repeat(80));
      console.log('Status: ' + proxyRes.statusCode + ' ' + proxyRes.statusMessage);
      
      console.log('\n📋 HEADERS DA RESPOSTA:');
      console.log('─'.repeat(80));
      Object.keys(proxyRes.headers).sort().forEach(function(key) {
        console.log('  ' + key + ': ' + proxyRes.headers[key]);
      });
      
      let responseChunks = [];
      proxyRes.on('data', function(chunk) {
        responseChunks.push(chunk);
      });
      
      proxyRes.on('end', function() {
        const responseBody = Buffer.concat(responseChunks).toString();
        
        console.log('\n📄 BODY DA RESPOSTA:');
        console.log('─'.repeat(80));
        console.log('Tamanho: ' + responseBody.length + ' bytes');
        
        if (responseBody) {
          try {
            const jsonBody = JSON.parse(responseBody);
            console.log(JSON.stringify(jsonBody, null, 2));
          } catch {
            console.log(responseBody);
          }
        } else {
          console.log('(Resposta sem body)');
        }
        
        console.log('\n' + '='.repeat(80) + '\n');
        
        // CORS headers
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
        
        delete headers['connection'];
        delete headers['transfer-encoding'];
        
        res.writeHead(proxyRes.statusCode, headers);
        res.end(responseBody);
      });
    });
    
    proxyReq.on('error', function(error) {
      console.error('\n' + '='.repeat(80));
      console.error('❌ ERRO NO ENCAMINHAMENTO');
      console.error('='.repeat(80));
      console.error('Erro: ' + error.message);
      console.error('Target: ' + targetUrl);
      console.error('Stack: ' + error.stack);
      
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
    
    proxyReq.on('timeout', function() {
      console.error('\n⏰ TIMEOUT NO ENCAMINHAMENTO');
      console.log('─'.repeat(80));
      console.error('Target: ' + targetUrl);
      console.error('Timeout: 30 segundos');
      proxyReq.destroy();
    });
    
    // Envia o body
    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  });
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 SERVIDOR DE INSPEÇÃO DE REQUISIÇÕES');
  console.log('='.repeat(80));
  console.log('📡 Rodando em: http://localhost:' + PORT);
  
  const networkInterfaces = os.networkInterfaces();
  console.log('\n🌐 ACESSÍVEL EM:');
  Object.keys(networkInterfaces).forEach(function(interfaceName) {
    networkInterfaces[interfaceName].forEach(function(iface) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('  ➜ http://' + iface.address + ':' + PORT);
      }
    });
  });
  
  console.log('\n🎯 ENCAMINHANDO PARA: ' + DESTINO.host + ':' + DESTINO.port);
  console.log('📝 Exemplo: /api/propostas/123 -> http://' + DESTINO.host + ':' + DESTINO.port + '/api/propostas/123');
  console.log('\n💡 Todos os dados da requisição serão exibidos no console');
  console.log('💾 Arquivos serão salvos em: ' + process.cwd() + '/uploads/');
  console.log('\n⏹️  Pressione Ctrl+C para parar');
  console.log('='.repeat(80) + '\n');
});