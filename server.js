const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fileUpload = require('express-fileupload');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÕES =====
const TARGET_SERVER = {
  baseURL: process.env.TARGET_URL || 'https://api-svsaude-hcommerce.hmg.marlin.com.br',
  timeout: 30000 // 30 segundos para arquivos grandes
};

// ===== MIDDLEWARES =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: '*',
  credentials: true,
  exposedHeaders: '*'
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Configuração específica para file upload
app.use(fileUpload({
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  createParentPath: true,
  parseNested: true,
  abortOnLimit: true,
  responseOnLimit: 'Arquivo muito grande. Máximo: 100MB'
}));

// Logging detalhado
app.use(morgan('dev'));

// ===== ROTA DE HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    target: TARGET_SERVER.baseURL,
    nodeVersion: process.version,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// ===== ROTA PARA VER LOGS =====
app.get('/logs', (req, res) => {
  try {
    const logPath = path.join(__dirname, 'proxy-logs.json');
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, 'utf8');
      const logData = JSON.parse(logs);
      res.json({
        total: logData.length,
        logs: logData.slice(-100)
      });
    } else {
      res.json({ total: 0, logs: [] });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao ler logs', message: error.message });
  }
});

// ===== FUNÇÃO PARA SALVAR LOG =====
function saveLog(logEntry) {
  try {
    const logPath = path.join(__dirname, 'proxy-logs.json');
    let logs = [];
    
    if (fs.existsSync(logPath)) {
      const data = fs.readFileSync(logPath, 'utf8');
      logs = JSON.parse(data);
    }
    
    logs.push(logEntry);
    
    if (logs.length > 1000) {
      logs = logs.slice(-1000);
    }
    
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch (error) {
    console.error('Erro ao salvar log:', error.message);
  }
}

// ===== FUNÇÃO PARA CONVERTER BUFFER EM STREAM =====
function bufferToStream(buffer) {
  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);
  return readable;
}

// ===== MIDDLEWARE DE INTERCEPTAÇÃO =====
app.use(async (req, res, next) => {
  // Ignora rotas internas
  if (req.path.startsWith('/health') || req.path.startsWith('/logs')) {
    return next();
  }

  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  const startTime = Date.now();

  // Log da requisição
  console.log('\n' + '='.repeat(80));
  console.log(`📨 REQUISIÇÃO #${requestId}`);
  console.log('='.repeat(80));
  console.log(`📌 Método: ${req.method}`);
  console.log(`📍 URL: ${req.url}`);
  console.log(`🖥️  IP: ${req.ip || req.connection.remoteAddress}`);
  
  // Verifica se tem arquivos
  const hasFiles = req.files && Object.keys(req.files).length > 0;
  if (hasFiles) {
    console.log(`📎 Arquivos recebidos:`);
    Object.keys(req.files).forEach(key => {
      const file = req.files[key];
      console.log(`   - ${key}: ${file.name} (${file.mimetype}, ${file.size} bytes)`);
    });
  }

  console.log(`📦 Body:`, JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));

  // Salva log da requisição
  saveLog({
    type: 'request',
    id: requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    headers: req.headers,
    ip: req.ip || req.connection.remoteAddress,
    hasFiles: hasFiles,
    files: hasFiles ? Object.keys(req.files).map(k => ({
      name: req.files[k].name,
      mimetype: req.files[k].mimetype,
      size: req.files[k].size
    })) : []
  });

  // ===== ENCAMINHA PARA O SERVIDOR DESTINO =====
  try {
    const targetURL = TARGET_SERVER.baseURL + req.url;
    console.log(`➡️ Encaminhando para: ${targetURL}`);

    // Prepara headers
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['connection'];
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    delete headers['accept-encoding'];

    // Adiciona headers de proxy
    headers['x-forwarded-for'] = req.ip || req.connection.remoteAddress;
    headers['x-forwarded-proto'] = req.protocol || 'https';
    headers['x-proxy-server'] = 'express-proxy-api';
    headers['x-request-id'] = requestId;

    let response;

    // ===== CASO 1: REQUISIÇÃO COM ARQUIVOS =====
    if (hasFiles) {
      console.log('📤 Processando upload de arquivos...');
      
      const formData = new FormData();
      
      // Adiciona campos do body
      Object.keys(req.body).forEach(key => {
        if (req.body[key] !== undefined && req.body[key] !== null) {
          formData.append(key, req.body[key]);
        }
      });
      
      // Adiciona arquivos
      Object.keys(req.files).forEach(key => {
        const file = req.files[key];
        // Cria um buffer a partir dos dados do arquivo
        const fileBuffer = file.data;
        // Adiciona ao FormData com nome, buffer e nome do arquivo
        formData.append(key, fileBuffer, {
          filename: file.name,
          contentType: file.mimetype || 'application/octet-stream'
        });
        console.log(`   ✅ Arquivo adicionado: ${file.name} (${file.mimetype})`);
      });

      // Faz a requisição com FormData
      response = await axios({
        method: req.method,
        url: targetURL,
        headers: {
          ...headers,
          ...formData.getHeaders()
        },
        data: formData,
        params: req.query,
        timeout: TARGET_SERVER.timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
      });
      
    // ===== CASO 2: REQUISIÇÃO JSON =====
    } else if (req.is('application/json') && Object.keys(req.body).length > 0) {
      console.log('📤 Enviando JSON...');
      response = await axios({
        method: req.method,
        url: targetURL,
        headers: headers,
        data: req.body,
        params: req.query,
        timeout: TARGET_SERVER.timeout,
        validateStatus: () => true
      });
      
    // ===== CASO 3: REQUISIÇÃO URL ENCODED =====
    } else if (req.is('application/x-www-form-urlencoded') && Object.keys(req.body).length > 0) {
      console.log('📤 Enviando URL Encoded...');
      response = await axios({
        method: req.method,
        url: targetURL,
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: new URLSearchParams(req.body).toString(),
        params: req.query,
        timeout: TARGET_SERVER.timeout,
        validateStatus: () => true
      });
      
    // ===== CASO 4: REQUISIÇÃO SEM BODY =====
    } else {
      console.log('📤 Enviando requisição sem body...');
      response = await axios({
        method: req.method,
        url: targetURL,
        headers: headers,
        params: req.query,
        timeout: TARGET_SERVER.timeout,
        validateStatus: () => true
      });
    }

    const duration = Date.now() - startTime;

    // Log da resposta
    console.log('\n' + '='.repeat(80));
    console.log(`⬅️ RESPOSTA #${requestId}`);
    console.log('='.repeat(80));
    console.log(`📊 Status: ${response.status} ${response.statusText}`);
    console.log(`⏱️  Duração: ${duration}ms`);
    console.log(`📦 Tamanho: ${JSON.stringify(response.data).length} bytes`);
    console.log('='.repeat(80) + '\n');

    // Salva log da resposta
    saveLog({
      type: 'response',
      id: requestId,
      timestamp: new Date().toISOString(),
      status: response.status,
      statusText: response.statusText,
      duration: duration + 'ms'
    });

    // Adiciona CORS headers
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Expose-Headers': '*'
    });

    // Retorna a resposta
    return res.status(response.status).json(response.data);

  } catch (error) {
    const duration = Date.now() - startTime;
    
    console.log('\n' + '='.repeat(80));
    console.log(`❌ ERRO #${requestId}`);
    console.log('='.repeat(80));
    console.log(`⏱️  Duração: ${duration}ms`);
    console.log(`💥 Erro: ${error.message}`);
    if (error.response) {
      console.log(`📊 Status: ${error.response.status}`);
      console.log(`📄 Data:`, error.response.data);
    }
    console.log('='.repeat(80) + '\n');

    // Salva log do erro
    saveLog({
      type: 'error',
      id: requestId,
      timestamp: new Date().toISOString(),
      error: error.message,
      duration: duration + 'ms',
      stack: error.stack
    });

    // Retorna erro
    const status = error.response ? error.response.status : 502;
    const message = error.response ? error.response.data : error.message;

    res.status(status).json({
      error: 'Proxy Error',
      message: message,
      requestId: requestId,
      timestamp: new Date().toISOString(),
      details: error.message
    });
  }
});

// ===== ROTA OPTIONS =====
app.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true'
  });
  res.sendStatus(204);
});

// ===== START SERVER =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 SERVIDOR PROXY EXPRESS');
  console.log('='.repeat(80));
  console.log(`✅ Rodando em: http://localhost:${PORT}`);
  console.log(`🎯 Encaminhando para: ${TARGET_SERVER.baseURL}`);
  console.log(`📋 Health Check: http://localhost:${PORT}/health`);
  console.log(`📊 Logs: http://localhost:${PORT}/logs`);
  console.log('='.repeat(80) + '\n');
});

// ===== TRATAMENTO DE ERROS =====
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
});