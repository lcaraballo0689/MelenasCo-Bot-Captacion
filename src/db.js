const { Pool } = require('pg');

// Crear una conexión con la base de datos PostgreSQL
const pool = new Pool({
    user: process.env.DBUSER,
    host: process.env.DBHOST,
    database: process.env.DBDATABASE,
    password: process.env.DBPASSWORD,
    port: process.env.DBPORT,
    client_encoding: 'UTF8',
});

module.exports = pool;
