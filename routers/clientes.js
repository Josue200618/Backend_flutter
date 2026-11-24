const express = require('express');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { httpError, requeridos, exigirId, paginacion, normalizarCorreo } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken);

const CAMPOS = 'id, tipo, nombre, razon_social, documento, telefono, correo, direccion, usuario_id, activo, creado_en';

router.get('/me', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `SELECT ${CAMPOS} FROM api_customers WHERE usuario_id = $1`,
            [req.usuario.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Este usuario no tiene perfil de cliente');
        }

        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.put('/me', async (req, res, next) => {
    try {
        const { rows } = await pool.query(
            `UPDATE api_customers SET
                nombre = COALESCE($1, nombre),
                razon_social = COALESCE($2, razon_social),
                telefono = COALESCE($3, telefono),
                direccion = COALESCE($4, direccion)
             WHERE usuario_id = $5
             RETURNING ${CAMPOS}`,
            [
                req.body.nombre || null,
                req.body.razon_social || null,
                req.body.telefono || null,
                req.body.direccion || null,
                req.usuario.id
            ]
        );

        if (!rows[0]) {
            throw httpError(404, 'Este usuario no tiene perfil de cliente');
        }

        if (req.body.nombre || req.body.telefono) {
            await pool.query(
                `UPDATE api_users SET
                    nombre = COALESCE($1, nombre),
                    telefono = COALESCE($2, telefono)
                 WHERE id = $3`,
                [req.body.nombre || null, req.body.telefono || null, req.usuario.id]
            );
        }

        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.get('/', exigirPermiso('clientes.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        const filtros = [];

        if (req.query.q) {
            valores.push(`%${req.query.q}%`);
            filtros.push(`(nombre ILIKE $${valores.length} OR documento ILIKE $${valores.length} OR COALESCE(razon_social, '') ILIKE $${valores.length} OR COALESCE(correo, '') ILIKE $${valores.length})`);
        }

        if (req.query.activo !== undefined) {
            valores.push(req.query.activo === 'true');
            filtros.push(`activo = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_customers ${where}`, valores);
        const data = await pool.query(
            `SELECT ${CAMPOS} FROM api_customers ${where}
             ORDER BY nombre
             LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
            [...valores, limit, offset]
        );

        res.json({ data: data.rows, total: Number(total.rows[0].count), page, limit });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', exigirPermiso('clientes.ver'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(`SELECT ${CAMPOS} FROM api_customers WHERE id = $1`, [req.params.id]);

        if (!rows[0]) {
            throw httpError(404, 'Cliente no encontrado');
        }

        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('clientes.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre', 'documento']);
        const tipo = req.body.tipo || 'persona';

        if (!['persona', 'empresa'].includes(tipo)) {
            throw httpError(400, 'El tipo de cliente debe ser persona o empresa');
        }

        if (tipo === 'empresa' && !req.body.razon_social) {
            throw httpError(400, 'La razón social es obligatoria para una empresa');
        }

        const { rows } = await pool.query(
            `INSERT INTO api_customers (tipo, nombre, razon_social, documento, telefono, correo, direccion)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING ${CAMPOS}`,
            [
                tipo,
                req.body.nombre.trim(),
                req.body.razon_social || null,
                String(req.body.documento).trim(),
                req.body.telefono || '',
                req.body.correo ? normalizarCorreo(req.body.correo) : '',
                req.body.direccion || ''
            ]
        );

        await registrarAuditoria(req.usuario.id, 'cliente_creado', { clienteId: rows[0].id });
        res.status(201).json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.put('/:id', exigirPermiso('clientes.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        if (req.body.tipo && !['persona', 'empresa'].includes(req.body.tipo)) {
            throw httpError(400, 'El tipo de cliente debe ser persona o empresa');
        }

        const { rows } = await pool.query(
            `UPDATE api_customers SET
                tipo = COALESCE($1, tipo),
                nombre = COALESCE($2, nombre),
                razon_social = COALESCE($3, razon_social),
                telefono = COALESCE($4, telefono),
                correo = COALESCE($5, correo),
                direccion = COALESCE($6, direccion),
                activo = COALESCE($7, activo)
             WHERE id = $8
             RETURNING ${CAMPOS}`,
            [
                req.body.tipo || null,
                req.body.nombre || null,
                req.body.razon_social || null,
                req.body.telefono || null,
                req.body.correo ? normalizarCorreo(req.body.correo) : null,
                req.body.direccion || null,
                req.body.activo === undefined ? null : req.body.activo,
                req.params.id
            ]
        );

        if (!rows[0]) {
            throw httpError(404, 'Cliente no encontrado');
        }

        await registrarAuditoria(req.usuario.id, 'cliente_actualizado', { clienteId: rows[0].id });
        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

module.exports = router;
