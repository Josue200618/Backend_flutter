const express = require('express');
const { pool } = require('../db/pool');
const verificarToken = require('../middleware/auth');
const exigirPermiso = require('../middleware/permiso');
const { httpError, exigirId, dinero, enteroPositivo } = require('../utils/validar');

const router = express.Router();
router.use(verificarToken, exigirPermiso('carrito.gestionar'));

async function obtenerCarritoId(usuarioId) {
    const { rows } = await pool.query(
        `INSERT INTO carritos (usuario_id)
         VALUES ($1)
         ON CONFLICT (usuario_id)
         DO UPDATE SET updated_at = NOW()
         RETURNING id_carrito`,
        [usuarioId]
    );
    return rows[0].id_carrito;
}

async function carritoDe(usuarioId) {
    const carritoId = await obtenerCarritoId(usuarioId);
    const { rows } = await pool.query(
        `SELECT d.product_id, p.nombre, p.precio, d.quantity AS cantidad, p.stock, p.activo,
                c.nombre AS categoria
         FROM cart_items d
         JOIN api_products p ON p.id = d.product_id
         LEFT JOIN api_categories c ON c.id = p.categoria_id
         WHERE d.cart_id = $1
         ORDER BY p.nombre`,
        [carritoId]
    );

    const items = rows.map((fila) => {
        const precio = dinero(fila.precio);
        return {
            producto_id: fila.product_id,
            nombre: fila.nombre,
            categoria: fila.categoria,
            precio,
            cantidad: fila.cantidad,
            subtotal: dinero(precio * fila.cantidad),
            stock: fila.stock,
            activo: fila.activo
        };
    });

    return {
        items,
        total: dinero(items.reduce((suma, item) => suma + item.subtotal, 0))
    };
}

router.get('/', async (req, res, next) => {
    try {
        res.json(await carritoDe(req.usuario.id));
    } catch (error) {
        next(error);
    }
});

router.post('/items', async (req, res, next) => {
    try {
        exigirId(req.body.producto_id);
        const cantidad = enteroPositivo(req.body.cantidad, 'La cantidad');
        const producto = await pool.query('SELECT id, activo FROM api_products WHERE id = $1', [req.body.producto_id]);

        if (!producto.rows[0] || !producto.rows[0].activo) {
            throw httpError(400, 'El producto no está disponible');
        }

        const carritoId = await obtenerCarritoId(req.usuario.id);
        await pool.query(
            `INSERT INTO detalle_carrito (carrito_id, productos_idproducto, cantidad)
             VALUES ($1, $2, $3)
             ON CONFLICT (carrito_id, productos_idproducto)
             DO UPDATE SET cantidad = detalle_carrito.cantidad + EXCLUDED.cantidad`,
            [carritoId, req.body.producto_id, cantidad]
        );

        res.status(201).json(await carritoDe(req.usuario.id));
    } catch (error) {
        next(error);
    }
});

router.put('/items/:productoId', async (req, res, next) => {
    try {
        exigirId(req.params.productoId);
        const cantidad = enteroPositivo(req.body.cantidad, 'La cantidad');
        const carritoId = await obtenerCarritoId(req.usuario.id);
        const { rowCount } = await pool.query(
            `UPDATE detalle_carrito SET cantidad = $1
             WHERE carrito_id = $2 AND productos_idproducto = $3`,
            [cantidad, carritoId, req.params.productoId]
        );

        if (!rowCount) {
            throw httpError(404, 'El producto no está en el carrito');
        }

        res.json(await carritoDe(req.usuario.id));
    } catch (error) {
        next(error);
    }
});

router.delete('/items/:productoId', async (req, res, next) => {
    try {
        exigirId(req.params.productoId);
        const carritoId = await obtenerCarritoId(req.usuario.id);
        await pool.query(
            'DELETE FROM detalle_carrito WHERE carrito_id = $1 AND productos_idproducto = $2',
            [carritoId, req.params.productoId]
        );
        res.json(await carritoDe(req.usuario.id));
    } catch (error) {
        next(error);
    }
});

router.delete('/', async (req, res, next) => {
    try {
        const carritoId = await obtenerCarritoId(req.usuario.id);
        await pool.query('DELETE FROM detalle_carrito WHERE carrito_id = $1', [carritoId]);
        res.json(await carritoDe(req.usuario.id));
    } catch (error) {
        next(error);
    }
});

module.exports = router;
