const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const {
    httpError,
    requeridos,
    exigirId,
    paginacion,
    normalizarCorreo
} = require('../utils/validar');

const router = express.Router();

router.use(verificarToken);

router.get('/', exigirPermiso('usuarios.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const filtros = [];
        const valores = [];

        if (req.query.nombre) {
            valores.push(`%${req.query.nombre}%`);
            filtros.push(`u.nombre ILIKE $${valores.length}`);
        }

        if (req.query.activo !== undefined) {
            valores.push(req.query.activo === 'true');
            filtros.push(`u.activo = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_users u ${where}`, valores);
        const data = await pool.query(
            `SELECT u.id, u.nombre, u.correo, u.telefono, u.activo, u.rol_id, r.nombre AS rol, u.creado_en
             FROM api_users u
             JOIN api_roles r ON r.id = u.rol_id
             ${where}
             ORDER BY u.id DESC
             LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
            [...valores, limit, offset]
        );

        res.json({ data: data.rows, total: Number(total.rows[0].count), page, limit });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', exigirPermiso('usuarios.ver'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            `SELECT u.id, u.nombre, u.correo, u.telefono, u.activo, u.rol_id, r.nombre AS rol, u.creado_en
             FROM api_users u
             JOIN api_roles r ON r.id = u.rol_id
             WHERE u.id = $1`,
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Usuario no encontrado');
        }

        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('usuarios.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre', 'correo', 'password', 'rol_id']);

        if (String(req.body.password).length < 8) {
            throw httpError(400, 'La contraseña debe tener al menos 8 caracteres');
        }

        const rol = await pool.query('SELECT id, nombre FROM api_roles WHERE id = $1', [req.body.rol_id]);
        if (!rol.rows[0]) {
            throw httpError(400, 'El rol no existe');
        }

        const passwordHash = await bcrypt.hash(String(req.body.password), 10);
        const { rows } = await pool.query(
            `INSERT INTO api_users (nombre, correo, telefono, password_hash, rol_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, nombre, correo, telefono, activo, rol_id`,
            [
                req.body.nombre.trim(),
                normalizarCorreo(req.body.correo),
                req.body.telefono || '',
                passwordHash,
                req.body.rol_id
            ]
        );

        await registrarAuditoria(req.usuario.id, 'usuario_creado', { usuarioId: rows[0].id, rol: rol.rows[0].nombre });
        res.status(201).json({ message: 'Usuario creado', usuario: { ...rows[0], rol: rol.rows[0].nombre } });
    } catch (error) {
        next(error);
    }
});

router.put('/:id', exigirPermiso('usuarios.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        if (Number(req.params.id) === req.usuario.id && req.body.activo === false) {
            throw httpError(400, 'No puedes desactivar tu propio usuario');
        }

        const actual = await pool.query('SELECT id FROM api_users WHERE id = $1', [req.params.id]);
        if (!actual.rows[0]) {
            throw httpError(404, 'Usuario no encontrado');
        }

        if (req.body.rol_id) {
            const rol = await pool.query('SELECT id FROM api_roles WHERE id = $1', [req.body.rol_id]);
            if (!rol.rows[0]) {
                throw httpError(400, 'El rol no existe');
            }
        }

        let passwordHash = null;
        if (req.body.password) {
            if (String(req.body.password).length < 8) {
                throw httpError(400, 'La contraseña debe tener al menos 8 caracteres');
            }
            passwordHash = await bcrypt.hash(String(req.body.password), 10);
        }

        const { rows } = await pool.query(
            `UPDATE api_users SET
                nombre = COALESCE($1, nombre),
                telefono = COALESCE($2, telefono),
                rol_id = COALESCE($3, rol_id),
                activo = COALESCE($4, activo),
                password_hash = COALESCE($5, password_hash)
             WHERE id = $6
             RETURNING id, nombre, correo, telefono, activo, rol_id`,
            [
                req.body.nombre || null,
                req.body.telefono || null,
                req.body.rol_id || null,
                req.body.activo === undefined ? null : req.body.activo,
                passwordHash,
                req.params.id
            ]
        );

        await registrarAuditoria(req.usuario.id, 'usuario_actualizado', { usuarioId: Number(req.params.id) });
        res.json({ message: 'Usuario actualizado', usuario: rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
