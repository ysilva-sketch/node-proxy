const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fileUpload = require('express-fileupload');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURAÇÕES =====
const TARGET_SERVER = {
  baseURL: process.env.TARGET_URL || 'https://api-svsaude-hcommerce.hmg.marlin.com.br',
  timeout: 15000 // 15 segundos
};

// ===== MIDDLEWARES =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: '*',
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(fileUpload({
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  createParentPath: true
}));

// Logging detalhado
app.use(morgan('combined'));

// ===== ROTA DE HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    target: TARGET_SERVER.baseURL,
    nodeVersion: process.version,
    uptime: process.uptime()
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
        logs: logData.slice(-100) // Últimos 100 logs
      });
    } else {
      res.json({ total: 0, logs: [] });
    }
  } catch (error) {
    res.status(500).json({ error: 'Erro ao ler logs', message: error.message });
  }
});

// ===== ROTA PARA LIMPAR LOGS =====
app.delete('/logs', (req, res) => {
  try {
    const logPath = path.join(__dirname, 'proxy-logs.json');
    if (fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, JSON.stringify([], null, 2));
    }
    res.json({ message: 'Logs limpos com sucesso' });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao limpar logs', message: error.message });
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
    
    // Mantém apenas os últimos 1000 logs
    if (logs.length > 1000) {
      logs = logs.slice(-1000);
    }
    
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch (error) {
    console.error('Erro ao salvar log:', error.message);
  }
}

// ===== FUNÇÃO PARA PROCESSAR BODY =====
function processBody(req) {
  // Para multipart/form-data
  if (req.files && Object.keys(req.files).length > 0) {
    const files = {};
    Object.keys(req.files).forEach(key => {
      const file = req.files[key];
      files[key] = {
        name: file.name,
        mimetype: file.mimetype,
        size: file.size,
        data: file.data.toString('base64').substring(0, 100) + '...' // Apenas preview
      };
    });
    return {
      type: 'multipart/form-data',
      fields: req.body,
      files: files
    };
  }
  
  // Para JSON
  if (req.is('application/json')) {
    return {
      type: 'application/json',
      data: req.body
    };
  }
  
  // Para URL encoded
  if (req.is('application/x-www-form-urlencoded')) {
    return {
      type: 'application/x-www-form-urlencoded',
      data: req.body
    };
  }
  
  // Para texto ou outros
  return {
    type: 'text/plain',
    data: req.body
  };
}

// ===== MIDDLEWARE DE INTERCEPTAÇÃO E LOG =====
app.use(async (req, res, next) => {
  // Ignora rotas internas
  if (req.path.startsWith('/health') || req.path.startsWith('/logs')) {
    return next();
  }

  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  const startTime = Date.now();

  // Prepara dados da requisição
  const requestData = {
    id: requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    headers: req.headers,
    ip: req.ip || req.connection.remoteAddress,
    body: processBody(req)
  };

  console.log('\n' + '='.repeat(80));
  console.log(`📨 REQUISIÇÃO #${requestId}`);
  console.log('='.repeat(80));
  console.log(`📌 Método: ${req.method}`);
  console.log(`📍 URL: ${req.url}`);
  console.log(`🖥️  IP: ${req.ip || req.connection.remoteAddress}`);
  console.log(`📦 Body Size: ${JSON.stringify(req.body).length} bytes`);
  console.log(`📋 Headers:`, JSON.stringify(req.headers, null, 2));
  
  if (req.files && Object.keys(req.files).length > 0) {
    console.log(`📎 Files:`, Object.keys(req.files).map(k => req.files[k].name));
  }
  
  console.log(`📄 Body:`, JSON.stringify(req.body, null, 2));
  console.log('='.repeat(80));

  // Salva log da requisição
  saveLog({
    type: 'request',
    ...requestData
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

    // Adiciona headers de proxy
    headers['x-forwarded-for'] = req.ip || req.connection.remoteAddress;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-proxy-server'] = 'express-proxy-api';
    headers['x-request-id'] = requestId;

    // Prepara dados para envio
    let data = null;
    let formData = null;

    if (req.files && Object.keys(req.files).length > 0) {
      // Multipart com arquivos
      formData = new FormData();
      Object.keys(req.body).forEach(key => {
        formData.append(key, req.body[key]);
      });
      Object.keys(req.files).forEach(key => {
        const file = req.files[key];
        formData.append(key, file.data, file.name);
      });
    } else {
      data = req.body;
    }

    // Configuração do axios
    const config = {
      method: req.method,
      url: targetURL,
      headers: headers,
      data: data,
      params: req.query,
      timeout: TARGET_SERVER.timeout,
      validateStatus: () => true // Aceita qualquer status
    };

    // Se for multipart, usa formData
    if (formData) {
      config.data = formData;
      config.headers['Content-Type'] = `multipart/form-data; boundary=${formData._boundary}`;
    }

    // Faz a requisição
    const response = await axios(config);
    const duration = Date.now() - startTime;

    // Prepara resposta para log
    const responseData = {
      id: requestId,
      timestamp: new Date().toISOString(),
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data,
      duration: duration + 'ms'
    };

    console.log('\n' + '='.repeat(80));
    console.log(`⬅️ RESPOSTA #${requestId}`);
    console.log('='.repeat(80));
    console.log(`📊 Status: ${response.status} ${response.statusText}`);
    console.log(`⏱️  Duração: ${duration}ms`);
    console.log(`📦 Tamanho: ${JSON.stringify(response.data).length} bytes`);
    console.log(`📄 Data:`, JSON.stringify(response.data, null, 2));
    console.log('='.repeat(80) + '\n');

    // Salva log da resposta
    saveLog({
      type: 'response',
      ...responseData
    });

    // Adiciona CORS headers
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Credentials': 'true'
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
      duration: duration + 'ms'
    });

    // Retorna erro
    const status = error.response ? error.response.status : 502;
    const message = error.response ? error.response.data : error.message;

    res.status(status).json({
      error: 'Proxy Error',
      message: message,
      requestId: requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// ===== ROTA CATCH-ALL PARA OPTIONS =====
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