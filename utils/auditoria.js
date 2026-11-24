const { pool } = require('../db/pool');

async function registrarAuditoria(usuarioId, accion, detalle, client = pool) {
    await client.query(
        'INSERT INTO auditoria (usuario_id, accion, detalle) VALUES ($1, $2, $3)',
        [usuarioId || null, accion, detalle ? JSON.stringify(detalle) : null]
    );
}

module.exports = {
    registrarAuditoria
};
