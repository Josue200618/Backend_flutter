const express = require('express');
const { randomBytes } = require('crypto');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const { usuarioSiHay } = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { tienePermiso } = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const {
    httpError,
    requeridos,
    exigirId,
    paginacion,
    dinero,
    enteroNoNegativo
} = require('../utils/validar');

const router = express.Router();

function mapProducto(fila) {
    return {
        ...fila,
        precio: dinero(fila.precio)
    };
}

router.get('/', async (req, res, next) => {
    try {
        if (req.query.todos === 'true' || req.query.activo === 'false') {
            const usuario = await usuarioSiHay(req);
            const permitido = usuario && await tienePermiso(usuario.rol_id, 'productos.gestionar');
            if (!permitido) {
                throw httpError(403, 'No tienes permiso para ver productos inactivos');
            }
        }

        const { page, limit, offset } = paginacion(req.query);
        const filtros = ['p.activo = TRUE'];
        const valores = [];

        if (req.query.activo === 'false') {
            filtros[0] = 'p.activo = FALSE';
        }

        if (req.query.todos === 'true') {
            filtros.shift();
        }

        if (req.query.nombre) {
            valores.push(`%${req.query.nombre}%`);
            filtros.push(`p.nombre ILIKE $${valores.length}`);
        }

        if (req.query.categoria_id) {
            exigirId(req.query.categoria_id);
            valores.push(req.query.categoria_id);
            filtros.push(`p.categoria_id = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_products p ${where}`, valores);
        const data = await pool.query(
            `SELECT p.id, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo, p.activo,
                    p.categoria_id, c.nombre AS categoria
             FROM api_products p
             LEFT JOIN api_categories c ON c.id = p.categoria_id
             ${where}
             ORDER BY p.nombre
             LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
            [...valores, limit, offset]
        );

        res.json({
            data: data.rows.map(mapProducto),
            total: Number(total.rows[0].count),
            page,
            limit
        });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            `SELECT p.id, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo, p.activo,
                    p.categoria_id, c.nombre AS categoria
             FROM api_products p
             LEFT JOIN api_categories c ON c.id = p.categoria_id
             WHERE p.id = $1`,
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Producto no encontrado');
        }

        res.json(mapProducto(rows[0]));
    } catch (error) {
        next(error);
    }
});

router.post('/', verificarToken, exigirPermiso('productos.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre', 'precio', 'categoria_id']);
        exigirId(req.body.categoria_id);

        const precio = Number(req.body.precio);
        if (!Number.isFinite(precio) || precio < 0) {
            throw httpError(400, 'El precio no es válido');
        }

        const stock = req.body.stock === undefined ? 0 : enteroNoNegativo(req.body.stock, 'El stock');
        const stockMinimo = req.body.stock_minimo === undefined
            ? 0
            : enteroNoNegativo(req.body.stock_minimo, 'El stock mínimo');
        const categoria = await pool.query('SELECT id FROM api_categories WHERE id = $1', [req.body.categoria_id]);
        if (!categoria.rows[0]) {
            throw httpError(400, 'La categoría no existe');
        }

        const { rows } = await pool.query(
            `INSERT INTO api_products (categoria_id, sku, nombre, descripcion, precio, stock, stock_minimo)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, categoria_id, nombre, descripcion, precio, stock, stock_minimo, activo`,
            [
                req.body.categoria_id,
                `LP-${randomBytes(8).toString('hex').toUpperCase()}`,
                req.body.nombre.trim(),
                req.body.descripcion || '',
                precio,
                stock,
                stockMinimo
            ]
        );

        await registrarAuditoria(req.usuario.id, 'producto_creado', { productoId: rows[0].id });
        res.status(201).json(mapProducto(rows[0]));
    } catch (error) {
        next(error);
    }
});

router.put('/:id', verificarToken, exigirPermiso('productos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        if (req.body.precio !== undefined) {
            const precio = Number(req.body.precio);
            if (!Number.isFinite(precio) || precio < 0) {
                throw httpError(400, 'El precio no es válido');
            }
        }

        if (req.body.stock !== undefined) {
            enteroNoNegativo(req.body.stock, 'El stock');
        }

        if (req.body.stock_minimo !== undefined) {
            enteroNoNegativo(req.body.stock_minimo, 'El stock mínimo');
        }

        if (req.body.activo !== undefined && typeof req.body.activo !== 'boolean') {
            throw httpError(400, 'El estado activo debe ser verdadero o falso');
        }

        if (req.body.categoria_id) {
            exigirId(req.body.categoria_id);
            const categoria = await pool.query('SELECT id FROM api_categories WHERE id = $1', [req.body.categoria_id]);
            if (!categoria.rows[0]) {
                throw httpError(400, 'La categoría no existe');
            }
        }

        const { rows } = await pool.query(
            `UPDATE api_products SET
                categoria_id = COALESCE($1, categoria_id),
                nombre = COALESCE($2, nombre),
                descripcion = COALESCE($3, descripcion),
                precio = COALESCE($4, precio),
                stock = COALESCE($5, stock),
                stock_minimo = COALESCE($6, stock_minimo),
                activo = COALESCE($7, activo)
             WHERE id = $8
             RETURNING id, categoria_id, nombre, descripcion, precio, stock, stock_minimo, activo`,
            [
                req.body.categoria_id || null,
                req.body.nombre || null,
                req.body.descripcion || null,
                req.body.precio === undefined ? null : Number(req.body.precio),
                req.body.stock === undefined ? null : Number(req.body.stock),
                req.body.stock_minimo === undefined ? null : Number(req.body.stock_minimo),
                req.body.activo === undefined ? null : req.body.activo,
                req.params.id
            ]
        );

        if (!rows[0]) {
            throw httpError(404, 'Producto no encontrado');
        }

        await registrarAuditoria(req.usuario.id, 'producto_actualizado', { productoId: rows[0].id });
        res.json(mapProducto(rows[0]));
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', verificarToken, exigirPermiso('productos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            `UPDATE api_products SET activo = FALSE WHERE id = $1
             RETURNING id, nombre, activo`,
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Producto no encontrado');
        }

        await registrarAuditoria(req.usuario.id, 'producto_desactivado', { productoId: rows[0].id });
        res.json({ message: 'Producto desactivado', producto: rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
