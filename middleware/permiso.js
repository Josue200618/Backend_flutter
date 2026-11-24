const { pool } = require('../db/pool');

async function tienePermiso(rolId, codigo) {
    const { rows } = await pool.query(
        `SELECT 1
         FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = $1 AND p.code = $2
         LIMIT 1`,
        [rolId, codigo]
    );

    return Boolean(rows[0]);
}

function exigirPermiso(...codigos) {
    return async (req, res, next) => {
        try {
            const { rows } = await pool.query(
                `SELECT 1
                 FROM role_permissions rp
                 JOIN permissions p ON p.id = rp.permission_id
                 WHERE rp.role_id = $1
                   AND p.code = ANY($2::text[])
                 LIMIT 1`,
                [req.usuario.rol_id, codigos]
            );

            if (!rows[0]) {
                return res.status(403).json({
                    message: 'No tienes permiso para esta acción'
                });
            }

            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = exigirPermiso;
module.exports.tienePermiso = tienePermiso;
