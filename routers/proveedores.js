const express = require('express');
const { randomBytes } = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { httpError, requeridos, exigirId, paginacion, dinero } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken);

async function productosDelProveedor(proveedorId) {
    const { rows } = await pool.query(
        `SELECT pp.producto_id, p.nombre, pp.costo_adquisicion, p.stock, p.stock_minimo
         FROM proveedor_producto pp
         JOIN api_products p ON p.id = pp.producto_id
         WHERE pp.proveedor_id = $1
         ORDER BY p.nombre`,
        [proveedorId]
    );

    return rows.map((fila) => ({
        ...fila,
        costo_adquisicion: dinero(fila.costo_adquisicion)
    }));
}

async function guardarProductos(client, proveedorId, productos) {
    if (!Array.isArray(productos)) {
        return;
    }

    await client.query('DELETE FROM proveedor_producto WHERE proveedor_id = $1', [proveedorId]);

    for (const item of productos) {
        if (!item || item.producto_id === undefined || item.costo_adquisicion === undefined) {
            throw httpError(400, 'Cada producto del proveedor necesita producto_id y costo_adquisicion');
        }

        exigirId(item.producto_id);
        const costo = Number(item.costo_adquisicion);
        if (!Number.isFinite(costo) || costo < 0) {
            throw httpError(400, 'El costo de adquisición no es válido');
        }

        const existe = await client.query('SELECT id FROM api_products WHERE id = $1', [item.producto_id]);
        if (!existe.rows[0]) {
            throw httpError(400, `El producto ${item.producto_id} no existe`);
        }

        await client.query(
            `INSERT INTO proveedor_producto (proveedor_id, producto_id, costo_adquisicion)
             VALUES ($1, $2, $3)`,
            [proveedorId, item.producto_id, costo]
        );
    }
}

router.get('/', exigirPermiso('proveedores.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        const filtros = [];

        if (req.query.nombre) {
            valores.push(`%${req.query.nombre}%`);
            filtros.push(`nombre ILIKE $${valores.length}`);
        }

        if (req.query.activo !== undefined) {
            valores.push(req.query.activo === 'true');
            filtros.push(`activo = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_suppliers ${where}`, valores);
        const data = await pool.query(
            `SELECT id, nombre, correo, telefono, direccion, activo
             FROM api_suppliers
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

router.get('/:id', exigirPermiso('proveedores.ver'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            'SELECT id, nombre, correo, telefono, direccion, activo FROM api_suppliers WHERE id = $1',
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Proveedor no encontrado');
        }

        res.json({ ...rows[0], productos: await productosDelProveedor(req.params.id) });
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('proveedores.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['nombre']);

        const proveedor = await withTransaction(async (client) => {
            const creado = await client.query(
                `INSERT INTO api_suppliers (documento, nombre, correo, telefono, direccion)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING id, nombre, correo, telefono, direccion, activo`,
                [
                    `PROV-${randomBytes(8).toString('hex').toUpperCase()}`,
                    req.body.nombre.trim(),
                    req.body.correo || '',
                    req.body.telefono || '',
                    req.body.direccion || ''
                ]
            );

            await guardarProductos(client, creado.rows[0].id, req.body.productos);
            return creado.rows[0];
        });

        await registrarAuditoria(req.usuario.id, 'proveedor_creado', { proveedorId: proveedor.id });
        res.status(201).json({ ...proveedor, productos: await productosDelProveedor(proveedor.id) });
    } catch (error) {
        next(error);
    }
});

router.put('/:id', exigirPermiso('proveedores.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        const proveedor = await withTransaction(async (client) => {
            const actualizado = await client.query(
                `UPDATE api_suppliers SET
                    nombre = COALESCE($1, nombre),
                    correo = COALESCE($2, correo),
                    telefono = COALESCE($3, telefono),
                    direccion = COALESCE($4, direccion),
                    activo = COALESCE($5, activo)
                 WHERE id = $6
                 RETURNING id, nombre, correo, telefono, direccion, activo`,
                [
                    req.body.nombre || null,
                    req.body.correo || null,
                    req.body.telefono || null,
                    req.body.direccion || null,
                    req.body.activo === undefined ? null : req.body.activo,
                    req.params.id
                ]
            );

            if (!actualizado.rows[0]) {
                throw httpError(404, 'Proveedor no encontrado');
            }

            await guardarProductos(client, req.params.id, req.body.productos);
            return actualizado.rows[0];
        });

        await registrarAuditoria(req.usuario.id, 'proveedor_actualizado', { proveedorId: proveedor.id });
        res.json({ ...proveedor, productos: await productosDelProveedor(proveedor.id) });
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', exigirPermiso('proveedores.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const { rows } = await pool.query(
            'UPDATE api_suppliers SET activo = FALSE WHERE id = $1 RETURNING id, nombre, activo',
            [req.params.id]
        );

        if (!rows[0]) {
            throw httpError(404, 'Proveedor no encontrado');
        }

        await registrarAuditoria(req.usuario.id, 'proveedor_desactivado', { proveedorId: rows[0].id });
        res.json({ message: 'Proveedor desactivado', proveedor: rows[0] });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
