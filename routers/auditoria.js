const express = require('express');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { paginacion } = require('../utils/validar');

const router = express.Router();

router.get('/', verificarToken, exigirPermiso('auditoria.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const total = await pool.query('SELECT COUNT(*) FROM auditoria');
        const data = await pool.query(
            `SELECT a.id, a.usuario_id, u.nombre AS usuario, a.accion, a.detalle, a.creado_en
             FROM auditoria a
             LEFT JOIN api_users u ON u.id = a.usuario_id
             ORDER BY a.creado_en DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        res.json({
            data: data.rows.map((fila) => ({
                ...fila,
                detalle: fila.detalle ? JSON.parse(fila.detalle) : null
            })),
            total: Number(total.rows[0].count),
            page,
            limit
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
