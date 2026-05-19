const { Client, GatewayIntentBits, AttachmentBuilder, Events } = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const axios = require('axios');
const { Pool } = require('pg');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// Initialize Gemini AI (Ensure GEMINI_API_KEY is set in .env)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ============================================================
// Global Error Handlers — ป้องกันบอทดับจาก Unhandled Errors
// ============================================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Unhandled Rejection at:', promise, 'reason:', reason);
    // ไม่ exit — ให้บอทรันต่อไป
});

process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error);
    // ไม่ exit — ให้บอทรันต่อไป (docker restart จะจัดการถ้าจำเป็น)
});

// ============================================================
// Discord Client Setup
// ============================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// ============================================================
// PostgreSQL Connection — พร้อม Retry Logic
// ============================================================
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    // Connection pool settings เพื่อลดการใช้ RAM บน e2-micro
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Handle pool-level errors so they don't crash the process
pool.on('error', (err) => {
    console.error('⚠️ PostgreSQL Pool Error (idle client):', err.message);
});

/**
 * รอจนกว่า PostgreSQL จะพร้อม — ลองเชื่อมต่อซ้ำทุก 3 วินาที
 */
async function waitForDatabase(maxRetries = 10) {
    for (let i = 1; i <= maxRetries; i++) {
        try {
            const res = await pool.query('SELECT NOW()');
            console.log(`✅ Database connected! Server time: ${res.rows[0].now}`);
            return true;
        } catch (err) {
            console.log(`⏳ [${i}/${maxRetries}] Waiting for database... (${err.message})`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    console.error('❌ Could not connect to database after retries. Bot will continue without DB.');
    return false;
}

const PYTHON_WORKER_URL = process.env.PYTHON_WORKER_URL || 'http://python-worker:5000';

// ============================================================
// Bot Events
// ============================================================
client.once(Events.ClientReady, c => {
    console.log(`✅ Core Bot Ready! Logged in as ${c.user.tag}`);
    console.log(`📡 Serving ${c.guilds.cache.size} guild(s)`);
});

/**
 * หาห้องที่บอทส่งข้อความได้
 * ลำดับ: WELCOME_CHANNEL_ID (env) → systemChannel → text channel แรกที่ส่งได้
 */
function findWelcomeChannel(guild) {
    // 1. ใช้ห้องที่กำหนดไว้ใน .env ก่อน
    const welcomeId = process.env.WELCOME_CHANNEL_ID;
    if (welcomeId) {
        const configured = guild.channels.cache.get(welcomeId);
        if (configured) return configured;
    }

    // 2. ใช้ systemChannel
    if (guild.systemChannel) return guild.systemChannel;

    // 3. Fallback: หา text channel แรกที่บอทมีสิทธิ์ส่ง
    const fallback = guild.channels.cache.find(
        ch => ch.isTextBased() && !ch.isThread() && ch.permissionsFor(guild.members.me)?.has('SendMessages')
    );
    return fallback || null;
}

// ============================================================
// Card Image Generator — สร้างรูป Welcome/Goodbye สวยๆ
// ============================================================
const WELCOME_BG = path.join(__dirname, 'assets', 'welcome_bg.png');
const GOODBYE_BG = path.join(__dirname, 'assets', 'goodbye_bg.png');

/**
 * สร้างรูป Card สำหรับ Welcome หรือ Goodbye
 * @param {'welcome'|'goodbye'} type - ประเภท card
 * @param {object} opts - { displayName, tag, memberCount, avatarUrl }
 * @returns {Promise<Buffer>} PNG buffer
 */
async function generateCard(type, { displayName, tag, memberCount, avatarUrl }) {
    const W = 1000, H = 500;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 1. วาด Background Image
    try {
        const bgPath = type === 'welcome' ? WELCOME_BG : GOODBYE_BG;
        const bg = await loadImage(bgPath);
        ctx.drawImage(bg, 0, 0, W, H);
    } catch (err) {
        // Fallback gradient ถ้าโหลดรูปไม่ได้
        const gradient = ctx.createLinearGradient(0, 0, W, H);
        if (type === 'welcome') {
            gradient.addColorStop(0, '#1a0533');
            gradient.addColorStop(1, '#2d1b69');
        } else {
            gradient.addColorStop(0, '#87CEEB');
            gradient.addColorStop(1, '#b0d4f1');
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, W, H);
    }

    // 2. ตำแหน่ง Avatar — จัดให้ตรงกับกรอบวงกลมในรูป Background
    // Welcome: วงกลมเงินอยู่กลาง-บน | Goodbye: วงกลมขาวอยู่กลาง-บน
    const avatarX = type === 'welcome' ? 500 : 500;
const avatarY = type === 'welcome' ? 170 : 170;
const avatarR = type === 'welcome' ? 130 : 130;

    if (avatarUrl) {
        try {
            const avatar = await loadImage(avatarUrl);

            // Clip and draw avatar ให้อยู่ในกรอบวงกลมของ background
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.drawImage(avatar, avatarX - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
            ctx.restore();

            // Subtle glow รอบ avatar ให้กลมกลืนกับกรอบ
            if (type === 'welcome') {
                // Glow สีม่วง-เงิน ให้เข้ากับธีม
                for (let i = 3; i >= 1; i--) {
                    ctx.beginPath();
                    ctx.arc(avatarX, avatarY, avatarR + i * 4, 0, Math.PI * 2);
                    ctx.strokeStyle = `rgba(200, 180, 255, ${0.15 / i})`;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
            }

            // Bubble shine highlight
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarY, avatarR, 0, Math.PI * 2);
            ctx.clip();
            const shine = ctx.createRadialGradient(avatarX - 25, avatarY - 35, 10, avatarX, avatarY, avatarR);
            shine.addColorStop(0, 'rgba(255, 255, 255, 0.2)');
            shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
            ctx.fillStyle = shine;
            ctx.fillRect(avatarX - avatarR, avatarY - avatarR, avatarR * 2, avatarR * 2);
            ctx.restore();
        } catch (err) {
            console.error('Error loading avatar:', err.message);
        }
    }

    return canvas.toBuffer('image/png');
}

// --- Welcome Image ---
client.on(Events.GuildMemberAdd, async member => {
    console.log(`👤 Member joined: ${member.user.tag} in ${member.guild.name}`);
    try {
        const channel = findWelcomeChannel(member.guild);
        if (!channel) {
            console.warn('⚠️ No channel found to send welcome message!');
            return;
        }
        console.log(`📨 Sending welcome image to #${channel.name}`);

        const buffer = await generateCard('welcome', {
            displayName: member.user.displayName,
            tag: member.user.tag,
            memberCount: member.guild.memberCount,
            avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
        });

        const attachment = new AttachmentBuilder(buffer, { name: 'welcome.png' });
        await channel.send({ content: `ยินดีต้อนรับ <@${member.id}>`, files: [attachment] });
        console.log(`✅ Welcome image sent for ${member.user.tag}`);

    } catch (error) {
        console.error('Error generating welcome image:', error);
    }
});

// --- Goodbye Image ---
client.on(Events.GuildMemberRemove, async member => {
    console.log(`👤 Member left: ${member.user.tag} from ${member.guild.name}`);
    try {
        const channel = findWelcomeChannel(member.guild);
        if (!channel) {
            console.warn('⚠️ No channel found to send goodbye message!');
            return;
        }

        const buffer = await generateCard('goodbye', {
            displayName: member.user.displayName,
            tag: member.user.tag,
            memberCount: member.guild.memberCount,
            avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 256 }),
        });

        const attachment = new AttachmentBuilder(buffer, { name: 'goodbye.png' });
        await channel.send({ content: `<@${member.id}> ออกจากเซิร์ฟไปแล้ว`, files: [attachment] });
        console.log(`✅ Goodbye image sent for ${member.user.tag}`);
    } catch (error) {
        console.error('Error sending goodbye image:', error);
    }
});

// ============================================================
// Fuzzy Matching — รองรับการพิมพ์ผิดเล็กน้อยสำหรับคำสั่งภาษาไทย
// ============================================================

/**
 * คำนวณ Levenshtein Distance ระหว่างสอง string
 * ยิ่งค่าน้อย = ยิ่งคล้ายกัน
 */
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

/**
 * ตรวจสอบว่า input ตรงหรือคล้ายกับคำสั่งที่กำหนดหรือไม่
 * @param {string} input - คำสั่งที่ผู้ใช้พิมพ์ (เฉพาะส่วนคำสั่ง ไม่รวม args)
 * @param {string[]} commands - รายการคำสั่งที่ถูกต้อง
 * @param {number} threshold - จำนวนตัวอักษรที่ยอมให้พิมพ์ผิดได้ (default: 2)
 * @returns {string|null} คำสั่งที่ match หรือ null
 */
function fuzzyMatch(input, commands, threshold = 2) {
    // 1. Exact match ก่อน
    const exact = commands.find(cmd => input === cmd);
    if (exact) return exact;

    // 2. Fuzzy match — หาคำสั่งที่คล้ายที่สุด
    let bestMatch = null;
    let bestDist = Infinity;
    for (const cmd of commands) {
        const dist = levenshtein(input, cmd);
        if (dist < bestDist && dist <= threshold) {
            bestDist = dist;
            bestMatch = cmd;
        }
    }
    return bestMatch;
}

/**
 * แยกคำสั่งออกจาก args โดยจับคู่กับรายการคำสั่งที่รู้จัก
 * รองรับทั้ง exact match และ fuzzy match
 */
function parseCommand(content) {
    if (!content.startsWith('/')) return { command: null, args: '', isFuzzy: false };

    // คำสั่งทั้งหมดที่รู้จัก (เรียงจากยาวไปสั้นเพื่อ match ยาวสุดก่อน)
    const allCommands = [
        '/สภาพอากาศ',
        '/ช่วยเหลือ',
        '/testwelcome',
        '/testgoodbye',
        '/weather',
        '/อากาศ',
        '/help',
        '/ช่วย',
        '/ping',
        '/tts',
        '/ask',
        '/ถาม',
    ];

    // ลอง exact startsWith ก่อน (เรียงจากยาวไปสั้น)
    const sorted = [...allCommands].sort((a, b) => b.length - a.length);
    for (const cmd of sorted) {
        if (content.startsWith(cmd)) {
            const rest = content.slice(cmd.length).trim();
            return { command: cmd, args: rest, isFuzzy: false };
        }
    }

    // ไม่เจอ exact → ลอง fuzzy match (ตัดที่ space แรก)
    const spaceIdx = content.indexOf(' ');
    const inputCmd = spaceIdx === -1 ? content : content.slice(0, spaceIdx);
    const inputArgs = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1).trim();

    const matched = fuzzyMatch(inputCmd, allCommands, 2);
    if (matched) {
        return { command: matched, args: inputArgs, isFuzzy: true };
    }

    return { command: null, args: '', isFuzzy: false };
}

// --- Commands ---
client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    // AI Mention Handle — ถ้ามีคน tag บอท จะให้ AI ตอบเลย
    if (message.mentions.has(client.user) && !message.mentions.everyone) {
        // ลบ tag บอทออกจากข้อความ
        const prompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
        if (prompt) {
            try {
                await message.channel.sendTyping();
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: `You are a helpful and friendly Discord bot. Keep your answers concise, well-formatted, and suitable for Discord.
User asked: ${prompt}`
                });
                return message.reply(response.text);
            } catch (error) {
                console.error('Gemini AI Error:', error);
                return message.reply('❌ ขออภัย ระบบ AI ขัดข้องชั่วคราว');
            }
        }
    }

    const { command, args: cmdArgs, isFuzzy } = parseCommand(message.content);
    if (!command) return; // ไม่ใช่คำสั่งที่รู้จัก

    // AI Command — /ask | /ถาม
    const askCmds = ['/ask', '/ถาม'];
    if (askCmds.includes(command)) {
        const prompt = cmdArgs;
        if (!prompt) return message.reply('🧠 พิมพ์คำถามที่ต้องการถามได้เลย (เช่น `/ถาม แนะนำเมนูอาหารเย็นหน่อย`)');

        try {
            await message.channel.sendTyping();
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `You are a helpful and friendly Discord bot. Keep your answers concise, well-formatted, and suitable for Discord.
User asked: ${prompt}`
            });
            return message.reply(response.text);
        } catch (error) {
            console.error('Gemini AI Error:', error);
            return message.reply('❌ ขออภัย ระบบ AI ขัดข้องชั่วคราว');
        }
    }

    // Weather Command — /weather (English) | /สภาพอากาศ, /อากาศ (Thai)
    const weatherThaiCmds = ['/สภาพอากาศ', '/อากาศ'];
    const isWeatherEN = command === '/weather';
    const isWeatherTH = weatherThaiCmds.includes(command);
    if (isWeatherEN || isWeatherTH) {
        const isThai = isWeatherTH;
        const args = cmdArgs.split(/\s+/).filter(Boolean);

        // แจ้งเมื่อ fuzzy match สำเร็จ
        if (isFuzzy) {
            await message.channel.send(`💡 คุณหมายถึง \`${command}\` ใช่ไหม? ดำเนินการให้เลย~`);
        }

        if (args.length === 0) {
            return message.reply(isThai
                ? '🌦️ กรุณาระบุชื่อเมือง เช่น `/สภาพอากาศ กรุงเทพ` หรือ `/อากาศ กรุงเทพ`'
                : '🌦️ Please provide a city name (e.g., `/weather Bangkok`)'
            );
        }

        const city = args.join(' ');
        try {
            const response = await axios.get('http://api.openweathermap.org/data/2.5/weather', {
                params: {
                    q: city,
                    appid: process.env.WEATHER_API_KEY,
                    units: 'metric',
                    lang: isThai ? 'th' : 'en'
                }
            });
            const w = response.data;

            const now = new Date();
            const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false });
            const dateStr = isThai
                ? `วันนี้ เวลา ${timeStr}`
                : `Today at ${timeStr}`;

            const embed = {
                color: 0x0099ff,
                title: isThai
                    ? `🌤️ สภาพอากาศใน ${w.name}, ${w.sys.country}`
                    : `🌤️ Weather in ${w.name}, ${w.sys.country}`,
                fields: [
                    {
                        name: isThai ? '🌡️ อุณหภูมิ' : '🌡️ Temperature',
                        value: isThai
                            ? `${w.main.temp}°C (รู้สึกเหมือน ${w.main.feels_like}°C)`
                            : `${w.main.temp}°C (feels like ${w.main.feels_like}°C)`,
                        inline: true
                    },
                    {
                        name: isThai ? '💧 ความชื้น' : '💧 Humidity',
                        value: `${w.main.humidity}%`,
                        inline: true
                    },
                    {
                        name: isThai ? '💨 ลม' : '💨 Wind',
                        value: `${w.wind.speed} m/s`,
                        inline: true
                    },
                    {
                        name: isThai ? '☁️ สภาพอากาศ' : '☁️ Condition',
                        value: w.weather[0].description,
                        inline: true
                    },
                ],
                footer: { text: dateStr },
                timestamp: new Date().toISOString(),
            };
            message.reply({ embeds: [embed] });
        } catch (error) {
            if (error.response && error.response.status === 404) {
                message.reply(isThai
                    ? '❌ ไม่พบเมืองนี้ กรุณาตรวจสอบชื่อแล้วลองใหม่อีกครั้ง'
                    : '❌ City not found. Please check the name and try again.'
                );
            } else {
                message.reply(isThai
                    ? '⚠️ ไม่สามารถดึงข้อมูลสภาพอากาศได้ กรุณาลองใหม่ภายหลัง'
                    : '⚠️ Could not fetch weather data. Please try again later.'
                );
            }
        }
    }

    // TTS Command (Sending task to Python Worker)
    if (command === '/tts') {
        const text = cmdArgs;
        if (!text) return message.reply('🔊 Please provide text to speak (e.g., `/tts สวัสดีครับ`)');

        try {
            await message.channel.sendTyping();

            // Forward request to Python worker
            const response = await axios.post(`${PYTHON_WORKER_URL}/tts`, { text }, {
                responseType: 'arraybuffer',
                timeout: 15000, // 15 second timeout
            });

            const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: 'tts.mp3' });
            await message.reply({ files: [attachment] });
        } catch (error) {
            console.error('Error communicating with TTS worker:', error.message);
            if (error.code === 'ECONNREFUSED') {
                message.reply('⚠️ TTS service is not available. Please try again later.');
            } else {
                message.reply('⚠️ An error occurred while generating TTS.');
            }
        }
    }

    // Test Welcome Command
    if (command === '/testwelcome') {
        try {
            const channel = findWelcomeChannel(message.guild);
            if (!channel) return message.reply('⚠️ ไม่พบห้อง Welcome! ตั้งค่า WELCOME_CHANNEL_ID ใน .env');

            const buffer = await generateCard('welcome', {
                displayName: message.author.displayName,
                tag: message.author.tag,
                memberCount: message.guild.memberCount,
                avatarUrl: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
            });

            const attachment = new AttachmentBuilder(buffer, { name: 'welcome.png' });
            await channel.send({ content: `ยินดีต้อนรับ <@${message.author.id}>`, files: [attachment] });
            if (channel.id !== message.channel.id) {
                message.reply(`✅ ส่ง Welcome Image ไปที่ <#${channel.id}> แล้ว!`);
            }
        } catch (error) {
            console.error('Error in testwelcome:', error);
            message.reply('⚠️ Error generating test welcome image.');
        }
    }

    // Test Goodbye Command
    if (command === '/testgoodbye') {
        try {
            const channel = findWelcomeChannel(message.guild);
            if (!channel) return message.reply('⚠️ ไม่พบห้อง Welcome! ตั้งค่า WELCOME_CHANNEL_ID ใน .env');

            const buffer = await generateCard('goodbye', {
                displayName: message.author.displayName,
                tag: message.author.tag,
                memberCount: message.guild.memberCount,
                avatarUrl: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
            });

            const attachment = new AttachmentBuilder(buffer, { name: 'goodbye.png' });
            await channel.send({ content: `<@${message.author.id}> ออกจากเซิร์ฟไปแล้ว`, files: [attachment] });
            if (channel.id !== message.channel.id) {
                message.reply(`✅ ส่ง Goodbye Image ไปที่ <#${channel.id}> แล้ว!`);
            }
        } catch (error) {
            console.error('Error in testgoodbye:', error);
            message.reply('⚠️ Error generating test goodbye image.');
        }
    }

    // Help Command — /help | /ช่วยเหลือ | /ช่วย
    const helpCmds = ['/help', '/ช่วยเหลือ', '/ช่วย'];
    if (helpCmds.includes(command)) {
        const isThai = command !== '/help';

        if (isFuzzy) {
            await message.channel.send(`💡 คุณหมายถึง \`${command}\` ใช่ไหม? ดำเนินการให้เลย~`);
        }

        const embed = {
            color: 0xe94560,
            title: isThai ? '📖 คำสั่งบอท' : '📖 Bot Commands',
            description: isThai
                ? '*💡 พิมพ์ผิดเล็กน้อยก็ไม่เป็นไร บอทเข้าใจได้!*'
                : '*💡 Typo-tolerant — minor typos are auto-corrected!*',
            fields: [
                { name: '/ask <คำถาม> | /ถาม', value: isThai ? 'ถามคำถามกับ AI (หรือแท็กชื่อบอทเพื่อคุยได้เลย)' : 'Ask a question to AI (Or tag the bot directly)' },
                { name: '/weather <city>', value: isThai ? 'ดูสภาพอากาศ (ตอบเป็นภาษาอังกฤษ)' : 'Get current weather for a city (English)' },
                { name: '/สภาพอากาศ <เมือง>  (/อากาศ)', value: isThai ? 'ดูสภาพอากาศ (ตอบเป็นภาษาไทย)' : 'Get current weather for a city (Thai)' },
                { name: '/tts <text>', value: isThai ? 'แปลงข้อความเป็นเสียงพูด (รองรับภาษาไทย)' : 'Convert text to speech (supports Thai)' },
                { name: '/testwelcome', value: isThai ? 'ทดสอบรูปต้อนรับ' : 'Test the welcome image' },
                { name: '/testgoodbye', value: isThai ? 'ทดสอบรูปลาก่อน' : 'Test the goodbye image' },
                { name: '/ping', value: isThai ? 'เช็คความหน่วงของบอท' : 'Check bot latency' },
                { name: '/help | /ช่วยเหลือ | /ช่วย', value: isThai ? 'แสดงข้อความช่วยเหลือนี้' : 'Show this help message' },
            ],
            footer: { text: 'Discord Utility Bot v1.0' },
        };
        message.reply({ embeds: [embed] });
    }

    // Ping Command
    if (command === '/ping') {
        const sent = await message.reply('🏓 Pinging...');
        sent.edit(`🏓 Pong! Latency: **${sent.createdTimestamp - message.createdTimestamp}ms** | API: **${Math.round(client.ws.ping)}ms**`);
    }
});

// ============================================================
// Startup Sequence — เรียง DB → Discord Login ตามลำดับ
// ============================================================
async function start() {
    console.log('🚀 Starting Discord Utility Bot...');

    // Step 1: Wait for database
    await waitForDatabase();

    // Step 2: Login to Discord
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
        console.error('❌ DISCORD_TOKEN is not set! Check your .env file.');
        process.exit(1);
    }

    try {
        await client.login(token);
    } catch (error) {
        console.error('❌ Failed to login to Discord:', error.message);
        console.error('   → Check if your DISCORD_TOKEN is correct and not expired.');
        console.error('   → Make sure you enabled Privileged Gateway Intents in Developer Portal.');
        process.exit(1);
    }
}

start();
