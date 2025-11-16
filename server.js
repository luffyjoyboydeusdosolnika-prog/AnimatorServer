// SERVER BACKEND - Deploy no Render.com
// Arquivo: server.js

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({extended: true, limit: '50mb'}));

// Armazenamento temporário (usar Redis em produção)
const tempStorage = new Map();

// ========== CONFIGURAÇÃO ROBLOX (variáveis de ambiente) ========== //
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE; // .ROBLOSECURITY cookie
const CREATOR_ID = process.env.CREATOR_ID; // Seu User ID
const CSRF_TOKEN_URL = 'https://auth.roblox.com/v2/logout';
const UPLOAD_URL = 'https://www.roblox.com/ide/publish/UploadNewAnimation';
const MARKETPLACE_URL = 'https://www.roblox.com/develop/library';

// ========== UTILITY: Obter CSRF Token ========== //
async function getCsrfToken() {
    try {
        const response = await axios.post(CSRF_TOKEN_URL, {}, {
            headers: {
                'Cookie': `.ROBLOSECURITY=${ROBLOX_COOKIE}`
            },
            validateStatus: () => true
        });
        
        return response.headers['x-csrf-token'];
    } catch (error) {
        console.error('Erro ao obter CSRF token:', error);
        return null;
    }
}

// ========== UTILITY: Converter Keyframes para KeyframeSequence XML ========== //
function keyframesToXML(keyframes, rigType) {
    let xml = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
    <Item class="KeyframeSequence" referent="RBX0">
        <Properties>
            <string name="Name">ExportedAnimation</string>
        </Properties>
`;
    
    // Agrupa keyframes por tempo
    const timeGroups = {};
    keyframes.forEach(kf => {
        const time = Math.round(kf.time * 100) / 100;
        if (!timeGroups[time]) {
            timeGroups[time] = [];
        }
        timeGroups[time].push(kf);
    });
    
    // Ordena tempos
    const sortedTimes = Object.keys(timeGroups).sort((a, b) => parseFloat(a) - parseFloat(b));
    
    // Cria Keyframes
    sortedTimes.forEach((time, idx) => {
        xml += `        <Item class="Keyframe" referent="KF${idx}">
            <Properties>
                <float name="Time">${time}</float>
            </Properties>
`;
        
        // Adiciona Poses
        timeGroups[time].forEach((kf, poseIdx) => {
            const c0 = kf.c0;
            const cframe = `${c0[0]}, ${c0[1]}, ${c0[2]}, ${c0[3]}, ${c0[4]}, ${c0[5]}, ${c0[6]}, ${c0[7]}, ${c0[8]}, ${c0[9]}, ${c0[10]}, ${c0[11]}`;
            
            xml += `            <Item class="Pose" referent="P${idx}_${poseIdx}">
                <Properties>
                    <CoordinateFrame name="CFrame">
                        <X>${c0[0]}</X>
                        <Y>${c0[1]}</Y>
                        <Z>${c0[2]}</Z>
                        <R00>${c0[3]}</R00>
                        <R01>${c0[4]}</R01>
                        <R02>${c0[5]}</R02>
                        <R10>${c0[6]}</R10>
                        <R11>${c0[7]}</R11>
                        <R12>${c0[8]}</R12>
                        <R20>${c0[9]}</R20>
                        <R21>${c0[10]}</R21>
                        <R22>${c0[11]}</R22>
                    </CoordinateFrame>
                    <token name="EasingDirection">1</token>
                    <token name="EasingStyle">${getEasingStyle(kf.easing)}</token>
                    <string name="Name">${kf.part}</string>
                    <float name="Weight">1</float>
                </Properties>
            </Item>
`;
        });
        
        xml += `        </Item>
`;
    });
    
    xml += `    </Item>
</roblox>`;
    
    return xml;
}

function getEasingStyle(easing) {
    const styles = {
        'Linear': '0',
        'EaseIn': '6',
        'EaseOut': '7',
        'EaseInOut': '8',
        'Bounce': '3'
    };
    return styles[easing] || '0';
}

// ========== ENDPOINT: Exportar para RBXM ========== //
app.post('/export', async (req, res) => {
    try {
        const {animation_name, keyframes, rig_type} = req.body;
        
        if (!keyframes || keyframes.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nenhum keyframe fornecido'
            });
        }
        
        // Gera XML do KeyframeSequence
        const xml = keyframesToXML(keyframes, rig_type);
        
        // Salva temporariamente
        const fileId = Date.now().toString();
        const fileName = `${animation_name}_${fileId}.rbxm`;
        const filePath = path.join(__dirname, 'temp', fileName);
        
        await fs.mkdir(path.join(__dirname, 'temp'), {recursive: true});
        await fs.writeFile(filePath, xml, 'utf8');
        
        // Armazena informações
        tempStorage.set(fileId, {
            fileName,
            filePath,
            keyframes,
            rig_type,
            animation_name,
            createdAt: Date.now()
        });
        
        // URL de download
        const downloadUrl = `${req.protocol}://${req.get('host')}/download/${fileId}`;
        
        res.json({
            success: true,
            file_id: fileId,
            download_url: downloadUrl,
            file_name: fileName
        });
        
    } catch (error) {
        console.error('Erro ao exportar:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ========== ENDPOINT: Download do RBXM ========== //
app.get('/download/:fileId', async (req, res) => {
    try {
        const {fileId} = req.params;
        const fileData = tempStorage.get(fileId);
        
        if (!fileData) {
            return res.status(404).json({
                success: false,
                error: 'Arquivo não encontrado'
            });
        }
        
        res.download(fileData.filePath, fileData.fileName, (err) => {
            if (err) {
                console.error('Erro no download:', err);
            }
            
            // Limpa arquivo após 1 hora
            setTimeout(async () => {
                try {
                    await fs.unlink(fileData.filePath);
                    tempStorage.delete(fileId);
                } catch (e) {
                    console.error('Erro ao limpar arquivo:', e);
                }
            }, 3600000);
        });
        
    } catch (error) {
        console.error('Erro no download:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ========== ENDPOINT: Publicar no Marketplace (Automação) ========== //
app.post('/publish', async (req, res) => {
    try {
        const {animation_name, description, keyframes, rig_type, price, for_sale} = req.body;
        
        if (!keyframes || keyframes.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nenhum keyframe fornecido'
            });
        }
        
        // Gera XML
        const xml = keyframesToXML(keyframes, rig_type);
        
        // Salva temporariamente
        const fileId = Date.now().toString();
        const fileName = `${animation_name.replace(/[^a-z0-9]/gi, '_')}_${fileId}.rbxm`;
        const filePath = path.join(__dirname, 'temp', fileName);
        
        await fs.mkdir(path.join(__dirname, 'temp'), {recursive: true});
        await fs.writeFile(filePath, xml, 'utf8');
        
        // ========== AUTOMAÇÃO COM PUPPETEER ========== //
        console.log('🤖 Iniciando automação do navegador...');
        
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        
        const page = await browser.newPage();
        
        // Define cookie de autenticação
        await page.setCookie({
            name: '.ROBLOSECURITY',
            value: ROBLOX_COOKIE,
            domain: '.roblox.com',
            path: '/',
            httpOnly: true,
            secure: true
        });
        
        // Navega para página de criação
        await page.goto('https://create.roblox.com/dashboard/creations', {
            waitUntil: 'networkidle2'
        });
        
        // Aguarda carregar
        await page.waitForTimeout(2000);
        
        // Clica em "Upload Asset" ou "Create"
        await page.waitForSelector('button[aria-label="Create"]', {timeout: 10000});
        await page.click('button[aria-label="Create"]');
        
        await page.waitForTimeout(1000);
        
        // Seleciona "Animation"
        await page.waitForSelector('button[data-testid="animation-option"]');
        await page.click('button[data-testid="animation-option"]');
        
        // Upload do arquivo
        const inputUploadHandle = await page.$('input[type=file]');
        await inputUploadHandle.uploadFile(filePath);
        
        await page.waitForTimeout(3000);
        
        // Preenche nome
        await page.waitForSelector('input[name="name"]');
        await page.type('input[name="name"]', animation_name);
        
        // Preenche descrição
        await page.waitForSelector('textarea[name="description"]');
        await page.type('textarea[name="description"]', description || 'Created with Studio Lite Animator');
        
        // Define preço (se for pago)
        if (for_sale && price > 0) {
            await page.waitForSelector('input[name="price"]');
            await page.type('input[name="price"]', price.toString());
        }
        
        // Clica em "Submit"
        await page.waitForSelector('button[type="submit"]');
        await page.click('button[type="submit"]');
        
        // Aguarda confirmação
        await page.waitForTimeout(5000);
        
        // Captura o asset ID da URL ou da página
        const currentUrl = page.url();
        const assetIdMatch = currentUrl.match(/\/(\d+)\//);
        const assetId = assetIdMatch ? assetIdMatch[1] : null;
        
        await browser.close();
        
        // Limpa arquivo
        await fs.unlink(filePath);
        
        if (assetId) {
            const marketplaceUrl = `https://create.roblox.com/store/asset/${assetId}`;
            
            res.json({
                success: true,
                asset_id: assetId,
                marketplace_url: marketplaceUrl,
                message: 'Animação publicada com sucesso!'
            });
        } else {
            res.json({
                success: true,
                message: 'Upload realizado, mas não foi possível capturar o Asset ID'
            });
        }
        
    } catch (error) {
        console.error('❌ Erro ao publicar:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
});

// ========== HEALTH CHECK ========== //
app.get('/health', (req, res) => {
    res.json({status: 'online', uptime: process.uptime()});
});

// ========== LIMPAR ARQUIVOS ANTIGOS (CRON JOB) ========== //
setInterval(async () => {
    const now = Date.now();
    const ONE_HOUR = 3600000;
    
    for (const [fileId, data] of tempStorage.entries()) {
        if (now - data.createdAt > ONE_HOUR) {
            try {
                await fs.unlink(data.filePath);
                tempStorage.delete(fileId);
                console.log(`🗑️ Arquivo removido: ${data.fileName}`);
            } catch (e) {
                console.error('Erro ao remover arquivo:', e);
            }
        }
    }
}, 600000); // A cada 10 minutos

// ========== INICIAR SERVIDOR ========== //
app.listen(PORT, () => {
    console.log(`✅ Servidor rodando na porta ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
});
