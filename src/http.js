require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const pool = require('./db'); // Conexión a PostgreSQL
const cron = require('node-cron');

// Inicializar la aplicación Express
const app = express();
const port = process.env.PORT || 3001;

// Configurar middlewares
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));

// Inicializar la API de Google Generative AI con la clave de API
const apiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(apiKey);

// Importar instrucciones de sistema desde un archivo externo
const systemInstruction = require('./iaModels/systemInstruction');
const analizaImagen = require('./iaModels/analizaImagen');

// Configuración del modelo principal
const model = genAI.getGenerativeModel({
    model: 'learnlm-1.5-pro-experimental',
    systemInstruction: systemInstruction,
});

// Configuración del modelo para visión
const visionModel = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-exp',
});

// Configuración de generación
const generationConfig = {
    temperature: 0,
    topP: 1,
    topK: 40,
    maxOutputTokens: 20192,
    responseMimeType: 'text/plain',
};

// Configuración de la limpieza de sesiones inactivas
const DIAS_INACTIVIDAD_PARA_ELIMINAR = process.env.CLEANUP_INTERVAL_DAYS || 15; // Valor por defecto: 15 días

// Función para guardar la sesión en la base de datos
const saveSessionToDB = async (clienteId, sessionData) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const sessionQuery = `
            INSERT INTO chat_sessions (cliente_id)
            VALUES ($1)
            ON CONFLICT (cliente_id) 
            DO UPDATE SET cliente_id = EXCLUDED.cliente_id 
            RETURNING id;
        `;
        const sessionValues = [clienteId];
        const sessionRes = await client.query(sessionQuery, sessionValues);
        const sessionId = sessionRes.rows[0].id;

        const deleteHistoryQuery = `DELETE FROM chat_history WHERE chat_session_id = $1`;
        await client.query(deleteHistoryQuery, [sessionId]);

        for (let i = 0; i < sessionData.history.length; i++) {
            const msg = sessionData.history[i];
            const historyQuery = `
                INSERT INTO chat_history (chat_session_id, role, message, message_order)
                VALUES ($1, $2, $3, $4);
            `;
            const historyValues = [sessionId, msg.role, msg.parts[0].text, i];
            await client.query(historyQuery, historyValues);
        }

        // Actualizar la fecha de la última interacción
        const updateLastInteractionQuery = `
            UPDATE chat_sessions
            SET last_interaction_at = CURRENT_TIMESTAMP
            WHERE id = $1;
        `;
        await client.query(updateLastInteractionQuery, [sessionId]);

        await client.query('COMMIT');
        console.log('Sesión y su historial almacenados en la base de datos. Session ID:', sessionId);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error al guardar sesión y su historial en la base de datos:', err);
    } finally {
        client.release();
    }
};

// Función para recuperar la sesión de la base de datos
const getSessionFromDB = async (clienteId) => {
    try {
        const sessionQuery = `SELECT id FROM chat_sessions WHERE cliente_id = $1`;
        const sessionValues = [clienteId];
        const sessionRes = await pool.query(sessionQuery, sessionValues);

        if (sessionRes.rows.length === 0) {
            console.log('No se encontró sesión para el clienteId:', clienteId);
            return null;
        }

        const sessionId = sessionRes.rows[0].id;

        const historyQuery = `
            SELECT role, message 
            FROM chat_history 
            WHERE chat_session_id = $1
            ORDER BY message_order;
        `;
        const historyValues = [sessionId];
        const historyRes = await pool.query(historyQuery, historyValues);

        let history = historyRes.rows.map(row => ({
            role: row.role,
            parts: [{ text: row.message }],
        }));

        return {
            history: history,
            generationConfig,
        };
    } catch (err) {
        console.error('Error al recuperar sesión de la base de datos:', err);
        return null;
    }
};

// Ruta para procesar texto e imágenes con Gemini AI
app.post('/geminiAi', async (req, res) => {
    try {
        console.log('Solicitud recibida:', req.body);

        const { mensaje, clienteId, imageUrl } = req.body;

        // Procesar texto
        if (mensaje && clienteId && !imageUrl) {
            console.log(`Procesando mensaje para clienteId: ${clienteId}`);
            console.log(`Mensaje recibido: ${mensaje}`);

            // Recuperar la sesión del cliente desde la base de datos
            let sessionData = await getSessionFromDB(clienteId);
            let chat;

            // Crear nueva sesión si no existe
            if (!sessionData) {
                console.log(`Creando nueva sesión para clienteId: ${clienteId}`);
                chat = model.startChat({
                    generationConfig,
                    history: [],
                });

                sessionData = {
                    history: [],
                    generationConfig,
                };
            } else {
                // Reconstruir el chat con el history recuperado
                chat = model.startChat(sessionData);
            }

            // Enviar el mensaje y obtener la respuesta
            const result = await chat.sendMessage(String(mensaje));
            const response = await result.response;
            const text = response.text();

            // Actualizar el historial en sessionData
            sessionData.history.push(
                { role: "user", parts: [{ text: mensaje }] },
                { role: "model", parts: [{ text: text }] }
            );

            // Guardar sesión actualizada
            await saveSessionToDB(clienteId, sessionData);

            return res.status(200).json({ response: text });
        }

        // Procesar imagen (con o sin mensaje adicional)
        if (imageUrl) {
            console.log('Procesando imagen:', imageUrl);

            // Obtener la imagen desde la URL usando axios
            const imageResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const base64Image = Buffer.from(imageResp.data).toString('base64');

            // Construcción del prompt
            let inputPrompt = analizaImagen;
            if (mensaje) {
                inputPrompt += `\nEl usuario también envió este mensaje: "${mensaje}"`;
            }

            // Generar el contenido usando el modelo de visión
            const result = await visionModel.generateContent([
                {
                    inlineData: {
                        data: base64Image,
                        mimeType: 'image/jpeg'
                    }
                },
                inputPrompt
            ]);

            // Acceder correctamente al texto de la respuesta
            const response = await result.response;
            const textContent = response.text();
            console.log('Respuesta generada para imagen:', textContent);
            return res.status(200).json({ caption: textContent });
        }

        return res.status(400).json({ error: 'Debe proporcionar un mensaje o una imageUrl.' });

    } catch (error) {
        console.error('Error en el procesamiento:', error);
        res.status(500).json({ error: 'Error en el procesamiento de la solicitud.' });
    }
});

// Funciones para manejar archivos
const getPdf = (req, res) => {
    const nombreArchivo = req.params.nombreArchivo;
    const rutaArchivoPDF = path.resolve(__dirname, 'public/archivo', nombreArchivo);

    fs.access(rutaArchivoPDF, fs.constants.F_OK, (err) => {
        if (err) {
            console.error('Archivo PDF no encontrado:', err);
            return res.status(404).send('Archivo no encontrado');
        }

        fs.readFile(rutaArchivoPDF, (err, data) => {
            if (err) {
                console.error('Error al leer el archivo PDF:', err);
                return res.status(500).send('Error al leer el archivo');
            }

            res.setHeader('Content-Type', 'application/pdf');
            res.send(data);
        });
    });
};

const getImage = (req, res) => {
    const nombreArchivo = req.params.nombreArchivo;
    const rutaArchivoImagen = path.resolve(__dirname, 'public/imagen', nombreArchivo);

    fs.access(rutaArchivoImagen, fs.constants.F_OK, (err) => {
        if (err) {
            console.error('Imagen no encontrada:', err);
            return res.status(404).send('Imagen no encontrada');
        }

        fs.readFile(rutaArchivoImagen, (err, data) => {
            if (err) {
                console.error('Error al leer la imagen:', err);
                return res.status(500).send('Error al leer la imagen');
            }

            const extension = path.extname(nombreArchivo).toLowerCase();
            const contentTypeMap = {
                '.png': 'image/png',
                '.gif': 'image/gif',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
            };
            const contentType = contentTypeMap[extension] || 'image/jpeg';

            res.setHeader('Content-Type', contentType);
            res.send(data);
        });
    });
};

const getVideo = (req, res) => {
    const nombreArchivo = req.params.nombreArchivo;
    const rutaArchivoVideo = path.resolve(__dirname, 'public/video', nombreArchivo);

    fs.access(rutaArchivoVideo, fs.constants.F_OK, (err) => {
        if (err) {
            console.error('Video no encontrado:', err);
            return res.status(404).send('Video no encontrado');
        }

        fs.readFile(rutaArchivoVideo, (err, data) => {
            if (err) {
                console.error('Error al leer el video:', err);
                return res.status(500).send('Error al leer el video');
            }

            const extension = path.extname(nombreArchivo).toLowerCase();
            const contentTypeMap = {
                '.webm': 'video/webm',
                '.ogg': 'video/ogg',
                '.mp4': 'video/mp4',
            };
            const contentType = contentTypeMap[extension] || 'video/mp4';

            res.setHeader('Content-Type', contentType);
            res.send(data);
        });
    });
};

app.get('/archivo/:nombreArchivo', getPdf);
app.get('/imagen/:nombreArchivo', getImage);
app.get('/video/:nombreArchivo', getVideo);

// Función para eliminar sesiones inactivas
async function eliminarSesionesInactivas(diasInactividad) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const deleteSessionsQuery = `
            DELETE FROM chat_sessions 
            WHERE last_interaction_at < CURRENT_TIMESTAMP - INTERVAL '$1 days';
        `;
        const deleteValues = [diasInactividad];
        const res = await client.query(deleteSessionsQuery, deleteValues);

        await client.query('COMMIT');
        console.log(`Eliminadas ${res.rowCount} sesiones inactivas.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error al eliminar sesiones inactivas:', err);
    } finally {
        client.release();
    }
}

// Programar la tarea de limpieza (ejecutarla todos los días a la 1:00 AM, por ejemplo)
cron.schedule('0 1 * * *', () => {
    console.log(`Ejecutando la limpieza de sesiones inactivas (más de ${DIAS_INACTIVIDAD_PARA_ELIMINAR} días de inactividad)...`);
    eliminarSesionesInactivas(DIAS_INACTIVIDAD_PARA_ELIMINAR);
});

// Crear tabla 'chat_sessions' si no existe
const createTableIfNotExists = async () => {
    const chatSessionsQuery = `
        CREATE TABLE IF NOT EXISTS chat_sessions (
            id SERIAL PRIMARY KEY,
            cliente_id VARCHAR(255) UNIQUE NOT NULL,
            last_interaction_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
    `;

    const chatHistoryQuery = `
        CREATE TABLE IF NOT EXISTS chat_history (
            id SERIAL PRIMARY KEY,
            chat_session_id INT REFERENCES chat_sessions(id) ON DELETE CASCADE,
            role VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            message_order INT NOT NULL
        );
    `;

    try {
        await pool.query(chatSessionsQuery);
        await pool.query(chatHistoryQuery);
        console.log('Tablas "chat_sessions" y "chat_history" aseguradas');
    } catch (err) {
        console.error('Error al crear las tablas:', err);
    }
};

// Llamar la función para crear la tabla al iniciar el servidor
createTableIfNotExists();

// Iniciar el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    // Ejecutar la limpieza al iniciar el servidor también (opcional)
    console.log(`Ejecutando limpieza inicial de sesiones inactivas (más de ${DIAS_INACTIVIDAD_PARA_ELIMINAR} días de inactividad)...`);
    eliminarSesionesInactivas(DIAS_INACTIVIDAD_PARA_ELIMINAR);
});