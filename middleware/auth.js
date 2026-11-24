const jwt = require('jsonwebtoken');
const keys = require('../settings/keys');
const { pool } = require('../db/pool');

const verificarToken = async (req, res, next) => {
    try {
        let token = req.headers.authorization;

        if (!token) {
            return res.status(401).json({
                message: 'Es necesario un token de autenticación'
            });
        }

        if (token.startsWith('Bearer ')) {
            token = token.slice(7);
        }

        const decoded = jwt.verify(token, keys.key);
        const { rows } = await pool.query(
            `SELECT u.id, u.nombre, u.correo, u.telefono, u.activo, u.rol_id, r.nombre AS rol
             FROM api_users u
             JOIN api_roles r ON r.id = u.rol_id
             WHERE u.id = $1`,
            [decoded.id]
        );

        if (!rows[0] || !rows[0].activo) {
            return res.status(401).json({
                message: 'La sesión no es válida'
            });
        }

        req.usuario = rows[0];
        next();
    } catch (error) {
        return res.status(401).json({
            message: 'El token no es válido'
        });
    }
};

async function usuarioSiHay(req) {
    try {
        let token = req.headers.authorization;

        if (!token) {
            return null;
        }

        if (token.startsWith('Bearer ')) {
            token = token.slice(7);
        }

        const decoded = jwt.verify(token, keys.key);
        const { rows } = await pool.query(
            'SELECT id, rol_id, activo FROM api_users WHERE id = $1',
            [decoded.id]
        );

        if (!rows[0] || !rows[0].activo) {
            return null;
        }

        return rows[0];
    } catch (error) {
        return null;
    }
}

module.exports = verificarToken;
module.exports.usuarioSiHay = usuarioSiHay;
