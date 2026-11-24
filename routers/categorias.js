const express = require('express');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const { usuarioSiHay } = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { tienePermiso } = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { httpError, requeridos, exigirId, paginacion } = require('../utils/validar');

const router = express.Router();

router.get('/', async (req, res, next) => {
    try {
        if (req.query.todos === 'true' || req.query.activo === 'false') {
            const usuario = await usuarioSiHay(req);
            const permitido = usuario && await tienePermiso(usuario.rol_id, 'categorias.gestionar');
            if (!permitido) {
                throw httpError(403, 'No tienes permiso para ver categorías inactivas');
            }
        }

        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        let where = 'WHERE activo = TRUE';

        if (req.query.activo === 'false' || req.query.todos === 'true') {
            where = req.query.activo === 'false' ? 'WHERE activo = FALSE' : '';
        }

        if (req.query.nombre) {
            valores.push(`%${req.query.nombre}%`);
            where += `${where ? ' AND' : 'WHERE'} nombre ILIKE $${valores.length}`;
        }

        const total = await pool.query(`SELECT COUNT(*) FROM api_categories ${where}`, valores);
        const data = await pool.query(
            `SELECT id, nombre, descripcion, activo
             FROM api_categories
             ${where}
             ORDER BY nombre
             LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
            [...valores, limit, offset]
        );

        res.json({ data: data.rows, total: Number(total.rows[0].count), page, limit });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            'SELECT id, nombre, descripcion, activo FROM api_categories WHERE id = $1',
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Categoría no encontrada');
        }

        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.post('/', verificarToken, exigirPermiso('categorias.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre']);
        const { rows } = await pool.query(
            `INSERT INTO api_categories (nombre, descripcion)
             VALUES ($1, $2)
             RETURNING id, nombre, descripcion, activo`,
            [req.body.nombre.trim(), req.body.descripcion || '']
        );

        await registrarAuditoria(req.usuario.id, 'categoria_creada', { categoriaId: rows[0].id });
        res.status(201).json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.put('/:id', verificarToken, exigirPermiso('categorias.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            `UPDATE api_categories
             SET nombre = COALESCE($1, nombre),
                 descripcion = COALESCE($2, descripcion),
                 activo = COALESCE($3, activo)
             WHERE id = $4
             RETURNING id, nombre, descripcion, activo`,
            [
                req.body.nombre || null,
                req.body.descripcion || null,
                req.body.activo === undefined ? null : req.body.activo,
                req.params.id
            ]
        );

        if (!rows[0]) {
            throw httpError(404, 'Categoría no encontrada');
        }

        await registrarAuditoria(req.usuario.id, 'categoria_actualizada', { categoriaId: rows[0].id });
        res.json(rows[0]);
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', verificarToken, exigirPermiso('categorias.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const usados = await pool.query('SELECT 1 FROM api_products WHERE categoria_id = $1 LIMIT 1', [req.params.id]);

        if (usados.rows[0]) {
            throw httpError(409, 'La categoría tiene productos. Desactívala en lugar de eliminarla');
        }

        const { rowCount } = await pool.query('DELETE FROM api_categories WHERE id = $1', [req.params.id]);
        if (!rowCount) {
            throw httpError(404, 'Categoría no encontrada');
        }

        await registrarAuditoria(req.usuario.id, 'categoria_eliminada', { categoriaId: Number(req.params.id) });
        res.json({ message: 'Categoría eliminada' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
