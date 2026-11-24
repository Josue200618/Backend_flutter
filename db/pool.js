const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
    throw new Error('Falta DATABASE_URL en el archivo .env');
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: '-c search_path=lacombalpalo'
});

async function withTransaction(trabajo) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const resultado = await trabajo(client);
        await client.query('COMMIT');
        return resultado;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    pool,
    withTransaction
};
