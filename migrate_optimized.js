const fs = require('fs');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const FILE_PATH = './reniec.txt';
const BATCH_SIZE = 1000; // Ajusta según estabilidad de tu internet
const DELIMITER = '|';  // Cambia si el archivo usa coma o tabulación

async function migrate() {
    console.log('🚀 Iniciando migración masiva a Supabase...');
    
    if (!fs.existsSync(FILE_PATH)) {
        console.error('❌ Error: No se encuentra reniec.txt en el directorio actual.');
        return;
    }

    const fileStream = fs.createReadStream(FILE_PATH);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let batch = [];
    let count = 0;
    let totalProcessed = 0;

    for await (const line of rl) {
        const parts = line.split(DELIMITER);
        
        // Mapeo (Ajusta los índices según tu archivo reniec.txt)
        if (parts.length >= 4) {
            batch.push({
                dni: parts[0]?.trim(),
                ap_pat: parts[1]?.trim(),
                ap_mat: parts[2]?.trim(),
                nombres: parts[3]?.trim(),
                fecha_nac: parts[4]?.trim() || null,
                ubigeo_dir: parts[5]?.trim() || null,
                direccion: parts[6]?.trim() || null
            });
            count++;
        }

        if (batch.length >= BATCH_SIZE) {
            const { error } = await supabase.from('reniec').upsert(batch, { onConflict: 'dni' });
            if (error) {
                console.error(`❌ Error en bloque:`, error.message);
            } else {
                totalProcessed += batch.length;
                console.log(`✅ Procesados: ${totalProcessed} registros...`);
            }
            batch = [];
        }
    }

    // Insertar remanentes
    if (batch.length > 0) {
        await supabase.from('reniec').upsert(batch, { onConflict: 'dni' });
        totalProcessed += batch.length;
    }

    console.log(`\n🎉 ¡MIGRACIÓN FINALIZADA! Total: ${totalProcessed} registros.`);
}

migrate().catch(err => console.error('🔥 Error fatal:', err));
