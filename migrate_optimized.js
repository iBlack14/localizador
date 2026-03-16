const mysql = require('mysql2/promise');
const fs = require('fs');
const readline = require('readline');
require('dotenv').config();

const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const RENIEC_FILE_PATH = process.env.RENIEC_FILE_PATH || './reniec.txt';
const BATCH_SIZE = 5000; 

async function migrate() {
    console.log('🚀 Iniciando Migración OPTIMIZADA de RENIEC...');
    const pool = mysql.createPool(dbConfig);

    try {
        // 1. Limpiar tabla y cambiar estructura para ahorrar espacio
        console.log('♻️  Limpiando y Reestructurando tabla "reniec" (Menos peso, más datos)...');
        await pool.query('DROP TABLE IF EXISTS reniec');
        await pool.query(`
            CREATE TABLE reniec (
                dni CHAR(8) PRIMARY KEY,
                ap_pat VARCHAR(80),
                ap_mat VARCHAR(80),
                nombres VARCHAR(120),
                fecha_nac VARCHAR(12),
                ubigeo_dir CHAR(6),
                direccion VARCHAR(200),
                INDEX idx_apellidos (ap_pat, ap_mat),
                INDEX idx_nombres (nombres)
            ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
        `);

        if (!fs.existsSync(RENIEC_FILE_PATH)) {
            console.error(`❌ El archivo no existe en: ${RENIEC_FILE_PATH}`);
            return;
        }

        const fileStream = fs.createReadStream(RENIEC_FILE_PATH);
        const rl = readline.createInterface({
            input: fileStream, crlfDelay: Infinity
        });

        let count = 0;
        let batch = [];
        let isHeader = true;

        for await (const line of rl) {
            if (isHeader) { isHeader = false; continue; }
            if (!line) continue;

            const cols = line.split('|');
            if (cols.length < 11) continue;

            // Extraemos solo lo esencial:
            // 0:dni, 1:ap_pat, 2:ap_mat, 3:nombres, 4:fecha_nac, 9:ubigeo, 10:direccion
            batch.push([
                cols[0].trim(), 
                cols[1]?.trim().substring(0, 80), 
                cols[2]?.trim().substring(0, 80), 
                cols[3]?.trim().substring(0, 120), 
                cols[4]?.trim().substring(0, 12),
                cols[9]?.trim().substring(0, 6),
                cols[10]?.trim().substring(0, 200)
            ]);

            if (batch.length >= BATCH_SIZE) {
                await insertBatch(pool, batch);
                count += batch.length;
                if (count % 50000 === 0) console.log(`✅ ${count.toLocaleString()} registros procesados...`);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await insertBatch(pool, batch);
            count += batch.length;
        }

        console.log(`\n✨ MIGRACIÓN OPTIMIZADA COMPLETADA ✨`);
        console.log(`📊 Total final: ${count.toLocaleString()} peruanos en el sistema.`);

    } catch (err) {
        console.error('❌ ERROR:', err.message);
    } finally {
        await pool.end();
    }
}

async function insertBatch(pool, batch) {
    const sql = `INSERT IGNORE INTO reniec (dni, ap_pat, ap_mat, nombres, fecha_nac, ubigeo_dir, direccion) VALUES ?`;
    try {
        await pool.query(sql, [batch]);
    } catch (err) {
        console.error('⚠️ Error en bloque:', err.message);
    }
}

migrate();
