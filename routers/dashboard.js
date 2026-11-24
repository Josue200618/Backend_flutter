const express = require('express');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { dinero } = require('../utils/validar');

const router = express.Router();

router.get('/', verificarToken, exigirPermiso('dashboard.ver'), async (req, res, next) => {
    try {
        const ventasMes = await pool.query(
            `SELECT COALESCE(SUM(total), 0) AS total, COUNT(*) AS cantidad
             FROM api_sales
             WHERE estado = 'activa'
               AND fecha >= date_trunc('month', NOW())`
        );

        const pedidos = await pool.query(
            `SELECT estado, COUNT(*)::int AS cantidad
             FROM api_orders
             GROUP BY estado`
        );

        const productos = await pool.query(
            `SELECT vd.producto_id, vd.nombre, SUM(vd.cantidad)::int AS unidades, SUM(vd.subtotal) AS total
             FROM api_sale_items vd
             JOIN api_sales v ON v.id = vd.venta_id
             WHERE v.estado = 'activa'
             GROUP BY vd.producto_id, vd.nombre
             ORDER BY unidades DESC
             LIMIT 5`
        );

        const clientes = await pool.query(
            `SELECT c.id, c.nombre, c.documento, COUNT(v.id)::int AS compras, SUM(v.total) AS total
             FROM api_customers c
             JOIN api_sales v ON v.cliente_id = c.id AND v.estado = 'activa'
             GROUP BY c.id
             ORDER BY compras DESC, total DESC
             LIMIT 5`
        );

        const bajoStock = await pool.query(
            `SELECT id, nombre, stock, stock_minimo
             FROM api_products
             WHERE activo = TRUE AND stock <= stock_minimo
             ORDER BY stock ASC, nombre`
        );

        const totales = await pool.query(
            `SELECT
                (SELECT COUNT(*) FROM api_products WHERE activo = TRUE) AS productos,
                (SELECT COUNT(*) FROM api_customers WHERE activo = TRUE) AS clientes,
                (SELECT COUNT(*) FROM api_suppliers WHERE activo = TRUE) AS proveedores,
                (SELECT COUNT(*) FROM api_orders) AS pedidos,
                (SELECT COUNT(*) FROM api_sales WHERE estado = 'activa') AS ventas`
        );

        const pedidosPorEstado = {
            pendiente: 0,
            aprobado: 0,
            rechazado: 0,
            entregado: 0,
            cancelado: 0
        };

        for (const fila of pedidos.rows) {
            pedidosPorEstado[fila.estado] = fila.cantidad;
        }

        res.json({
            ventasMes: dinero(ventasMes.rows[0].total),
            cantidadVentasMes: Number(ventasMes.rows[0].cantidad),
            pedidosPorEstado,
            productosMasVendidos: productos.rows.map((fila) => ({
                ...fila,
                total: dinero(fila.total)
            })),
            clientesFrecuentes: clientes.rows.map((fila) => ({
                ...fila,
                total: dinero(fila.total)
            })),
            productosBajoStock: bajoStock.rows,
            totales: {
                productos: Number(totales.rows[0].productos),
                clientes: Number(totales.rows[0].clientes),
                proveedores: Number(totales.rows[0].proveedores),
                pedidos: Number(totales.rows[0].pedidos),
                ventas: Number(totales.rows[0].ventas)
            }
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
