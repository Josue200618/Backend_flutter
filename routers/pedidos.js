const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { registrarAuditoria } = require('../utils/auditoria');
const { restarStock } = require('../utils/stock');
const { httpError, exigirId, paginacion, dinero, enteroPositivo } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken);

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

function mapDetalle(fila) {
    return {
        ...fila,
        precio_unitario: dinero(fila.precio_unitario),
        subtotal: dinero(fila.subtotal)
    };
}

async function pedidoCompleto(id) {
    const pedido = await pool.query(
        `SELECT p.id, p.cliente_id, c.nombre AS cliente, c.documento, p.usuario_id,
                p.fecha, p.estado, p.total, p.direccion_entrega, p.notas,
                p.aprobado_por, p.entregado_en
         FROM api_orders p
         JOIN api_customers c ON c.id = p.cliente_id
         WHERE p.id = $1`,
        [id]
    );

    if (!pedido.rows[0]) {
        return null;
    }

    const detalles = await pool.query(
        `SELECT id, producto_id, nombre, precio_unitario, cantidad, subtotal
         FROM api_order_items
         WHERE pedido_id = $1
         ORDER BY id`,
        [id]
    );

    return {
        ...pedido.rows[0],
        total: dinero(pedido.rows[0].total),
        detalles: detalles.rows.map(mapDetalle)
    };
}

async function insertarPedido(client, { clienteId, clienteUsuarioId, registradoPor, direccion, notas, lineas }) {
    const total = dinero(lineas.reduce((suma, linea) => suma + linea.subtotal, 0));
    const pedido = await client.query(
        `INSERT INTO orders (customer_id, user_id, total, delivery_address, notas, status, recorded_by)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id`,
        [clienteId, clienteUsuarioId, total, direccion, notas || null, registradoPor]
    );

    for (const linea of lineas) {
        await client.query(
            `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
             VALUES ($1, $2, $3, $4, $5)`,
            [pedido.rows[0].id, linea.producto_id, linea.nombre, linea.precio_unitario, linea.cantidad]
        );
    }

    return pedido.rows[0].id;
}

async function lineasDesdeProductos(client, items) {
    const lineas = [];
    const productosVistos = new Set();

    for (const item of items) {
        exigirId(item.producto_id);
        if (productosVistos.has(Number(item.producto_id))) {
            throw httpError(400, 'No repitas un producto en el detalle del pedido');
        }
        productosVistos.add(Number(item.producto_id));

        const cantidad = enteroPositivo(item.cantidad, 'La cantidad');
        const producto = await client.query(
            'SELECT id, nombre, precio, activo FROM api_products WHERE id = $1',
            [item.producto_id]
        );

        if (!producto.rows[0] || !producto.rows[0].activo) {
            throw httpError(400, `El producto ${item.producto_id} no está disponible`);
        }

        const precio = dinero(producto.rows[0].precio);
        lineas.push({
            producto_id: producto.rows[0].id,
            nombre: producto.rows[0].nombre,
            precio_unitario: precio,
            cantidad,
            subtotal: dinero(precio * cantidad)
        });
    }

    return lineas;
}

router.get('/', async (req, res, next) => {
    try {
        const veTodos = await tienePermiso(req.usuario.rol_id, 'pedidos.ver');
        const { page, limit, offset } = paginacion(req.query);
        const valores = [];
        const filtros = [];

        if (!veTodos) {
            valores.push(req.usuario.id);
            filtros.push(`p.usuario_id = $${valores.length}`);
        }

        if (req.query.estado) {
            valores.push(req.query.estado);
            filtros.push(`p.estado = $${valores.length}`);
        }

        const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';
        const total = await pool.query(`SELECT COUNT(*) FROM api_orders p ${where}`, valores);
        const data = await pool.query(
            `SELECT p.id, p.cliente_id, c.nombre AS cliente, p.fecha, p.estado, p.total, p.direccion_entrega
             FROM api_orders p
             JOIN api_customers c ON c.id = p.cliente_id
             ${where}
             ORDER BY p.fecha DESC
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

router.get('/:id', async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const pedido = await pedidoCompleto(req.params.id);

        if (!pedido) {
            throw httpError(404, 'Pedido no encontrado');
        }

        const veTodos = await tienePermiso(req.usuario.rol_id, 'pedidos.ver');
        if (!veTodos && pedido.usuario_id !== req.usuario.id) {
            throw httpError(403, 'No tienes permiso para ver este pedido');
        }

        res.json(pedido);
    } catch (error) {
        next(error);
    }
});

router.post('/', exigirPermiso('pedidos.crear'), async (req, res, next) => {
    try {
        const pedidoId = await withTransaction(async (client) => {
            const cliente = await client.query(
                'SELECT id, direccion, activo, usuario_id FROM api_customers WHERE usuario_id = $1',
                [req.usuario.id]
            );

            if (!cliente.rows[0] || !cliente.rows[0].activo) {
                throw httpError(400, 'Completa un perfil de cliente activo antes de pedir');
            }

            const direccion = (req.body.direccion_entrega || cliente.rows[0].direccion || '').trim();
            if (!direccion) {
                throw httpError(400, 'La dirección de entrega es obligatoria');
            }

            const carrito = await client.query('SELECT id_carrito AS id FROM carritos WHERE usuario_id = $1', [req.usuario.id]);
            if (!carrito.rows[0]) {
                throw httpError(400, 'El carrito está vacío');
            }

            const items = await client.query(
                'SELECT product_id AS producto_id, quantity AS cantidad FROM cart_items WHERE cart_id = $1',
                [carrito.rows[0].id]
            );

            if (items.rows.length === 0) {
                throw httpError(400, 'El carrito está vacío');
            }

            const lineas = await lineasDesdeProductos(client, items.rows);
            const id = await insertarPedido(client, {
                clienteId: cliente.rows[0].id,
                clienteUsuarioId: cliente.rows[0].usuario_id,
                registradoPor: req.usuario.id,
                direccion,
                notas: req.body.notas,
                lineas
            });

            await client.query('DELETE FROM detalle_carrito WHERE carrito_id = $1', [carrito.rows[0].id]);
            await registrarAuditoria(req.usuario.id, 'pedido_creado', { pedidoId: id }, client);
            return id;
        });

        res.status(201).json({
            message: 'Pedido registrado. Queda pendiente de aprobación.',
            pedido: await pedidoCompleto(pedidoId)
        });
    } catch (error) {
        next(error);
    }
});

router.post('/manual', exigirPermiso('pedidos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.body.cliente_id);

        if (!Array.isArray(req.body.detalles) || req.body.detalles.length === 0) {
            throw httpError(400, 'El pedido debe incluir al menos un producto');
        }

        const pedidoId = await withTransaction(async (client) => {
            const cliente = await client.query(
                'SELECT id, direccion, activo, usuario_id FROM api_customers WHERE id = $1',
                [req.body.cliente_id]
            );

            if (!cliente.rows[0] || !cliente.rows[0].activo) {
                throw httpError(400, 'El cliente no está disponible');
            }

            const direccion = (req.body.direccion_entrega || cliente.rows[0].direccion || '').trim();
            if (!direccion) {
                throw httpError(400, 'La dirección de entrega es obligatoria');
            }

            const lineas = await lineasDesdeProductos(client, req.body.detalles);
            const id = await insertarPedido(client, {
                clienteId: cliente.rows[0].id,
                clienteUsuarioId: cliente.rows[0].usuario_id,
                registradoPor: req.usuario.id,
                direccion,
                notas: req.body.notas,
                lineas
            });

            await registrarAuditoria(req.usuario.id, 'pedido_manual', { pedidoId: id }, client);
            return id;
        });

        res.status(201).json({
            message: 'Pedido registrado. Queda pendiente de aprobación.',
            pedido: await pedidoCompleto(pedidoId)
        });
    } catch (error) {
        next(error);
    }
});

router.put('/:id/aprobar', exigirPermiso('pedidos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const pedidoId = await withTransaction(async (client) => {
            const { rows } = await client.query(
                `UPDATE orders
                 SET status = 'approved', decided_by = $1, decided_at = NOW()
                 WHERE id = $2 AND status = 'pending'
                 RETURNING id`,
                [req.usuario.id, req.params.id]
            );

            if (!rows[0]) {
                throw httpError(400, 'Solo se puede aprobar un pedido pendiente');
            }

            await registrarAuditoria(req.usuario.id, 'pedido_aprobado', { pedidoId: rows[0].id }, client);
            return rows[0].id;
        });

        res.json({ message: 'Pedido aprobado', pedido: await pedidoCompleto(pedidoId) });
    } catch (error) {
        next(error);
    }
});

router.put('/:id/rechazar', exigirPermiso('pedidos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const pedidoId = await withTransaction(async (client) => {
            const { rows } = await client.query(
                `UPDATE orders
                 SET status = 'rejected', decided_by = $3, decided_at = NOW(),
                     notas = CASE WHEN $1::text IS NULL THEN notas ELSE CONCAT(COALESCE(notas, ''), ' | Rechazo: ', $1::text) END
                 WHERE id = $2 AND status = 'pending'
                 RETURNING id`,
                [req.body.motivo || null, req.params.id, req.usuario.id]
            );

            if (!rows[0]) {
                throw httpError(400, 'Solo se puede rechazar un pedido pendiente');
            }

            await registrarAuditoria(req.usuario.id, 'pedido_rechazado', { pedidoId: rows[0].id }, client);
            return rows[0].id;
        });

        res.json({ message: 'Pedido rechazado', pedido: await pedidoCompleto(pedidoId) });
    } catch (error) {
        next(error);
    }
});

router.put('/:id/cancelar', async (req, res, next) => {
    try {
        exigirId(req.params.id);
        const gestiona = await tienePermiso(req.usuario.rol_id, 'pedidos.gestionar');
        const pedidoId = await withTransaction(async (client) => {
            const pedido = await client.query(
                'SELECT id_pedido AS id, usuario_id, estado_pedido AS estado FROM pedido_venta WHERE id_pedido = $1 FOR UPDATE',
                [req.params.id]
            );

            if (!pedido.rows[0]) {
                throw httpError(404, 'Pedido no encontrado');
            }

            if (!gestiona && pedido.rows[0].usuario_id !== req.usuario.id) {
                throw httpError(403, 'No puedes cancelar este pedido');
            }

            if (pedido.rows[0].estado !== 'pendiente') {
                throw httpError(400, 'Solo se puede cancelar un pedido pendiente');
            }

            const actualizado = await client.query(
                "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id",
                [req.params.id]
            );

            if (!actualizado.rows[0]) {
                throw httpError(400, 'Solo se puede cancelar un pedido pendiente');
            }

            await registrarAuditoria(req.usuario.id, 'pedido_cancelado', { pedidoId: actualizado.rows[0].id }, client);
            return actualizado.rows[0].id;
        });

        res.json({ message: 'Pedido cancelado', pedido: await pedidoCompleto(pedidoId) });
    } catch (error) {
        next(error);
    }
});

router.put('/:id/entregar', exigirPermiso('pedidos.gestionar'), async (req, res, next) => {
    try {
        exigirId(req.params.id);

        const ventaId = await withTransaction(async (client) => {
            const pedido = await client.query(
                `SELECT id_pedido AS id, clientes_idclientes AS cliente_id,
                        estado_pedido AS estado, valor_total AS total
                 FROM pedido_venta
                 WHERE id_pedido = $1
                 FOR UPDATE`,
                [req.params.id]
            );

            if (!pedido.rows[0]) {
                throw httpError(404, 'Pedido no encontrado');
            }

            if (pedido.rows[0].estado !== 'approved') {
                throw httpError(400, 'Solo se puede entregar un pedido aprobado');
            }

            const detalles = await client.query(
                'SELECT producto_id, nombre, precio_unitario, cantidad, subtotal FROM api_order_items WHERE pedido_id = $1',
                [req.params.id]
            );

            await restarStock(client, detalles.rows);

            await client.query(
                `UPDATE orders
                 SET status = 'delivered', delivered_at = NOW(),
                     decided_by = $1, decided_at = NOW(), recorded_by = $1
                 WHERE id = $2`,
                [req.usuario.id, req.params.id]
            );
            await client.query('DELETE FROM venta_anulada WHERE pedido_id = $1', [req.params.id]);

            await registrarAuditoria(req.usuario.id, 'pedido_entregado', {
                pedidoId: Number(req.params.id),
                ventaId: Number(req.params.id)
            }, client);

            return Number(req.params.id);
        });

        res.json({
            message: 'Pedido entregado. Se registró la venta y se descontó el inventario.',
            ventaId,
            pedido: await pedidoCompleto(req.params.id)
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
