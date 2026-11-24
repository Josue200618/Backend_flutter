const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { sumarStock } = require('../utils/stock');
const { httpError, exigirId, paginacion, dinero } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken);

function mapDetalle(fila) {
    return {
        ...fila,
        precio_unitario: dinero(fila.precio_unitario),
        subtotal: dinero(fila.subtotal)
    };
}

async function ventaCompleta(id) {
    const venta = await pool.query(
        `SELECT id, pedido_id, cliente_id, cliente, documento,
                usuario_id, fecha, total, estado
         FROM api_sales
         WHERE id = $1`,
        [id]
    );

    if (!venta.rows[0]) {
        return null;
    }

    const detalles = await pool.query(
        `SELECT id, producto_id, nombre, precio_unitario, cantidad, subtotal
         FROM api_sale_items
         WHERE venta_id = $1
         ORDER BY id`,
        [id]
    );

    return {
        ...venta.rows[0],
        total: dinero(venta.rows[0].total),
        detalles: detalles.rows.map(mapDetalle)
    };
}

router.get('/', exigirPermiso('ventas.ver'), async (req, res, next) => {
    try {
        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        const filtros = [];

        if (req.query.estado) {
            valores.push(req.query.estado);
            filtros.push(`v.estado = $${valores.length}`);
        }

        if (req.query.cliente_id) {
            exigirId(req.query.cliente_id);
            valores.push(req.query.cliente_id);
            filtros.push(`v.cliente_id = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_sales v ${where}`, valores);
        const data = await pool.query(
            `SELECT v.id, v.pedido_id, v.cliente_id, v.cliente, v.fecha, v.total, v.estado
             FROM api_sales v
             ${where}
             ORDER BY v.fecha DESC
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

router.get('/:id', exigirPermiso('ventas.ver'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const venta = await ventaCompleta(req.params.id);
        if (!venta) {
            throw httpError(404, 'Venta no encontrada');
        }
        res.json(venta);
    } catch (error) {
        next(error);
    }
});

router.put('/:id/anular', exigirPermiso('ventas.anular'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        await withTransaction(async (client) => {
            const venta = await client.query(
                `SELECT id_pedido AS id, estado_pedido AS estado
                 FROM pedido_venta
                 WHERE id_pedido = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!venta.rows[0]) {
                throw httpError(404, 'Venta no encontrada');
            }

            if (venta.rows[0].estado !== 'delivered') {
                throw httpError(400, 'La venta ya está anulada');
            }

            const detalles = await client.query(
                'SELECT producto_id, cantidad FROM api_sale_items WHERE venta_id = $1',
                [req.params.id]
            );

            await sumarStock(client, detalles.rows);
            await client.query(
                "UPDATE orders SET status = 'approved', delivered_at = NULL WHERE id = $1",
                [venta.rows[0].id]
            );
            await client.query(
                `INSERT INTO venta_anulada (pedido_id, usuario_id)
                 VALUES ($1, $2)
                 ON CONFLICT (pedido_id)
                 DO UPDATE SET usuario_id = EXCLUDED.usuario_id, anulada_en = NOW()`,
                [venta.rows[0].id, req.usuario.id]
            );
            await registrarAuditoria(req.usuario.id, 'venta_anulada', { ventaId: Number(req.params.id) }, client);
        });

        res.json({ message: 'Venta anulada. El pedido volvió a estado aprobado y el stock fue devuelto.', venta: await ventaCompleta(req.params.id) });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
