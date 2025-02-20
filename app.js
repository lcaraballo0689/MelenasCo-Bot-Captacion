const dotenv = require("dotenv");
const axios = require("axios");
const { createBot, createProvider, createFlow, addKeyword, EVENTS } = require("@bot-whatsapp/bot");
const BaileysProvider = require("@bot-whatsapp/provider/baileys");
const PostgreSQLAdapter = require("@bot-whatsapp/database/postgres");
const ServerHttp = require("./src/http");
const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Carga las variables de entorno
dotenv.config({ path: "./.env" });

// Configuración de PostgreSQL
const POSTGRES_DB_HOST = process.env.DBHOST;
const POSTGRES_DB_USER = process.env.DBUSER;
const POSTGRES_DB_PASSWORD = process.env.DBPASSWORD;
const POSTGRES_DB_NAME = process.env.DBDATABASE;
const POSTGRES_DB_PORT = process.env.DBPORT;

// Función para enviar texto e imágenes a Gemini AI
const sendToGeminiAi = async (data) => {
    try {
        const response = await axios.post("http://192.168.0.33:3001/geminiAi", data);
        
        if (response.data.response) {
            console.log("Respuesta de Gemini AI:", response.data.response);
            return response.data.response;
        } else if (response.data.caption) {
            console.log("Respuesta de Gemini AI (Imagen):", response.data.caption);
            return response.data.caption;
        }

        return "No se recibió una respuesta válida de Gemini AI.";
    } catch (error) {
        console.error("Error al enviar datos a Gemini AI:", error.message);
        return "Hubo un error al procesar tu solicitud.";
    }
};

// Función para manejar la descarga y procesamiento de imágenes
const handleImageMessage = async (message, sock, clienteId) => {
    try {
        if (!message.message || !message.message.imageMessage) {
            console.log('No es un mensaje de imagen.');
            return;
        }

        // Descargar la imagen
        const stream = await downloadMediaMessage(message, 'buffer', { logger: console });

        // Generar un nombre de archivo único
        const imageId = uuidv4();
        const imagePath = path.join(__dirname, 'public/imagen', `${imageId}.jpg`);

        // Crear la carpeta si no existe
        if (!fs.existsSync(path.dirname(imagePath))) {
            fs.mkdirSync(path.dirname(imagePath), { recursive: true });
        }

        // Guardar la imagen
        fs.writeFileSync(imagePath, stream);
        console.log(`Imagen guardada en: ${imagePath}`);

        // Construir la URL de la imagen
        const imageUrl = `http://192.168.0.33:3001/imagen/${imageId}.jpg`;

        // Enviar la imagen a Gemini AI para su análisis
        return await sendToGeminiAi({ imageUrl, clienteId });

    } catch (error) {
        console.error('Error al procesar la imagen:', error);
        return "Error al procesar la imagen.";
    }
};

// Flujo principal del bot
const flowPrincipal = addKeyword(EVENTS.WELCOME)
    .addAction({ delay: 2000 }, async (ctx, { flowDynamic, provider }) => {
        const mensaje = ctx.body;
        const clienteId = ctx.from;

        // Obtener la instancia de sock
        const sock = await provider.getInstance();

        // Escuchar los mensajes entrantes
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const message = messages[0];
            if (!message.message) return;

            // Si el mensaje es de tipo imagen, lo procesamos
            if (message.message.imageMessage) {
                const visionResponse = await handleImageMessage(message, sock, clienteId);
                return await flowDynamic(visionResponse);
            }
        });

        // Enviar datos a Gemini AI y obtener la respuesta
        const responseMessage = await sendToGeminiAi({ mensaje, clienteId });

        // Validar si la respuesta contiene el código 'e101' y adjuntar un PDF si es necesario
        if (responseMessage.toLowerCase().includes("e101")) {
            await flowDynamic([{ body: "Enlace:", media: "http://192.168.0.33:3001/archivo/test.pdf" }]);
        }

        // Enviar el mensaje de respuesta
        return await flowDynamic(responseMessage);
    });

// Función principal para inicializar el bot y el servidor HTTP
const main = async () => {
    const adapterDB = new PostgreSQLAdapter({
        host: POSTGRES_DB_HOST,
        user: POSTGRES_DB_USER,
        database: POSTGRES_DB_NAME,
        password: POSTGRES_DB_PASSWORD,
        port: POSTGRES_DB_PORT,
    });

    const adapterFlow = createFlow([flowPrincipal]);
    const adapterProvider = createProvider(BaileysProvider);

    const bot = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    app.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
          const { number, intent } = req.body;
          if (intent === 'remove') botInstance.blacklist.remove(number);
          if (intent === 'add') botInstance.blacklist.add(number);
          return res.status(200).json({ status: 'ok', number, intent });
        })
      );
    const serverHttp = new ServerHttp();
    serverHttp.initialization(bot);
};

// Iniciar la aplicación
main().catch((error) => {
    console.error("Error en la inicialización:", error.message);
});
