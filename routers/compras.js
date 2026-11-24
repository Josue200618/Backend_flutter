const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { sumarStock, restarStock } = require('../utils/stock');
const { httpError, requeridos, exigirId, paginacion, dinero } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken);

function mapDetalle(fila) {
    return {
        ...fila,
        costo_unitario: dinero(fila.costo_unitario),
        subtotal: dinero(fila.subtotal)
    };
}

async function compraCompleta(id) {
    const compra = await pool.query(
        `SELECT c.id, c.proveedor_id, pr.nombre AS proveedor, c.usuario_id, c.fecha, c.total, c.estado
         FROM api_purchases c
         JOIN api_suppliers pr ON pr.id = c.proveedor_id
         WHERE c.id = $1`,
        [id]
    );

    if (!compra.rows[0]) {
        return null;
    }

    const detalles = await pool.query(
        `SELECT d.id, d.producto_id, d.nombre, d.cantidad, d.costo_unitario, d.subtotal
         FROM api_purchase_items d
         WHERE d.compra_id = $1`,
        [id]
    );

    return {
        ...compra.rows[0],
        total: dinero(compra.rows[0].total),
        detalles: detalles.rows.map(mapDetalle)
    };
}

router.get('/', exigirPermiso('compras.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        const filtros = [];

        if (req.query.estado) {
            valores.push(req.query.estado);
            filtros.push(`c.estado = $${valores.length}`);
        }

        if (req.query.proveedor_id) {
            exigirId(req.query.proveedor_id);
            valores.push(req.query.proveedor_id);
            filtros.push(`c.proveedor_id = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_purchases c ${where}`, valores);
        const data = await pool.query(
            `SELECT c.id, c.proveedor_id, pr.nombre AS proveedor, c.fecha, c.total, c.estado
             FROM api_purchases c
             JOIN api_suppliers pr ON pr.id = c.proveedor_id
             ${where}
             ORDER BY c.fecha DESC
             LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
            [...valores, limit, offset]
        );

        res.json({
            data: data.rows.map((fila) => ({ ...fila, total: dinero(fila.total) })),
            total: Number(total.rows[0].count),
            page,
            limit
        });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', exigirPermiso('compras.ver'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const compra = await compraCompleta(req.params.id);
        if (!compra) {
            throw httpError(404, 'Compra no encontrada');
        }
        res.json(compra);
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('compras.gestionar'), async (req, res, next) => {
    try {
        requeridos(req.body, ['proveedor_id', 'detalles']);
        exigirId(req.body.proveedor_id);

        if (!Array.isArray(req.body.detalles) || req.body.detalles.length === 0) {
            throw httpError(400, 'La compra debe incluir al menos un producto');
        }

        const compraId = await withTransaction(async (client) => {
            const proveedor = await client.query('SELECT id, activo FROM api_suppliers WHERE id = $1', [req.body.proveedor_id]);
            if (!proveedor.rows[0] || !proveedor.rows[0].activo) {
                throw httpError(400, 'El proveedor no está disponible');
            }

            const lineas = [];
            const productosVistos = new Set();
            for (const item of req.body.detalles) {
                exigirId(item.producto_id);
                if (productosVistos.has(Number(item.producto_id))) {
                    throw httpError(400, 'No repitas un producto en el detalle de la compra');
                }
                productosVistos.add(Number(item.producto_id));

                const cantidad = Number(item.cantidad);
                const costo = Number(item.costo_unitario);

                if (!Number.isInteger(cantidad) || cantidad <= 0) {
                    throw httpError(400, 'La cantidad debe ser un entero mayor que cero');
                }

                if (!Number.isFinite(costo) || costo < 0) {
                    throw httpError(400, 'El costo unitario no es válido');
                }

                const producto = await client.query('SELECT id, activo FROM api_products WHERE id = $1', [item.producto_id]);
                if (!producto.rows[0] || !producto.rows[0].activo) {
                    throw httpError(400, `El producto ${item.producto_id} no está disponible`);
                }

                lineas.push({
                    producto_id: Number(item.producto_id),
                    cantidad,
                    costo_unitario: dinero(costo),
                    subtotal: dinero(cantidad * costo)
                });
            }

            const total = dinero(lineas.reduce((suma, linea) => suma + linea.subtotal, 0));
            const compra = await client.query(
                `INSERT INTO purchases (supplier_id, created_by, total, status, received_at)
                 VALUES ($1, $2, $3, 'received', NOW())
                 RETURNING id`,
                [req.body.proveedor_id, req.usuario.id, total]
            );

            for (const linea of lineas) {
                await client.query(
                    `INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost)
                     VALUES ($1, $2, $3, $4)`,
                    [compra.rows[0].id, linea.producto_id, linea.cantidad, linea.costo_unitario]
                );
            }

            await sumarStock(client, lineas);
            await registrarAuditoria(req.usuario.id, 'compra_creada', { compraId: compra.rows[0].id, total }, client);
            return compra.rows[0].id;
        });

        res.status(201).json({
            message: 'Compra registrada. El inventario fue actualizado.',
            compra: await compraCompleta(compraId)
        });
    } catch (error) {
        next(error);
    }
});

router.put('/:id/anular', exigirPermiso('compras.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        await withTransaction(async (client) => {
            const compra = await client.query('SELECT id_compra AS id, estado_compra AS estado FROM compra WHERE id_compra = $1 FOR UPDATE', [req.params.id]);
            if (!compra.rows[0]) {
                throw httpError(404, 'Compra no encontrada');
            }

            if (compra.rows[0].estado !== 'received') {
                throw httpError(400, 'La compra ya está anulada');
            }

            const detalles = await client.query(
                'SELECT product_id AS producto_id, quantity AS cantidad FROM purchase_items WHERE purchase_id = $1',
                [req.params.id]
            );

            await restarStock(client, detalles.rows);
            await client.query("UPDATE purchases SET status = 'cancelled' WHERE id = $1", [req.params.id]);
            await registrarAuditoria(req.usuario.id, 'compra_anulada', { compraId: Number(req.params.id) }, client);
        });

        res.json({ message: 'Compra anulada y stock revertido', compra: await compraCompleta(req.params.id) });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
